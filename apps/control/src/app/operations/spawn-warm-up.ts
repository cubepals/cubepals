// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A new world's spawn made before anyone arrives. Since 1.21.9 Minecraft prepares no spawn as it
 * starts: the first player's join generates the chunks around it, so a new world's first join took
 * 19-21 s where every later one takes 3-5 s. Once a world's first boot is done and nobody is on,
 * `warm_spawn` force-loads the 7×7 chunks around the world spawn (whose neighbours a forced chunk
 * brings to full as well, which covers where a player lands within the spawn radius), waits until
 * they are loaded, and takes the force-load off again. The chunks are on disk from then on.
 *
 * It is its own background operation, queued by the boot that brought the world up
 * (`warmingAfterBoot`), so it never holds up letting a player in, and the server's queue runs it apart
 * from any stop: a sleep or stop waits for it, and the force-load is gone before the server goes
 * down. A player who joins mid-way joins as before. It adds the force-load only on a world that has
 * none, and takes off only its own square, so a ticket the owner set stays theirs. An attempt cut
 * short leaves its square for the next attempt, which finds it and finishes.
 *
 * Not for: chunks beyond spawn (a pre-generation), or worlds whose game prepares its spawn at start.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { SECOND_MS } from '@blockly/contracts/durations'
import { compareVersions } from '@blockly/contracts/release-order'
import { type AppliedConfigJson, type Db, schema, type Tx } from '@blockly/db'
import { and, eq, like } from 'drizzle-orm'
import { LIST_UUIDS, parseOnlinePlayers } from '../../minecraft/console.ts'
import type { ConsoleTarget, ServerConsole } from '../ports/minecraft.ts'
import { findServer } from '../servers/persistence.ts'
import { loadRevisionFields } from '../servers/revision-reads.ts'
import type { ServerTransitions } from '../servers/transitions.ts'
import type { ServerBinding } from './handlers/binding.ts'
import type { GameConsole } from './handlers/game-console.ts'
import type { OperationContext, OperationHandler } from './runner.ts'

/** The first release whose server prepares no spawn as it starts (`PrepareSpawnTask` at join). */
const SPAWN_AT_FIRST_JOIN = '1.21.9'

/** Chunks either side of the spawn chunk: 3 makes the 7×7 a join loads around its player. */
const RADIUS_CHUNKS = 3
const CHUNK_BLOCKS = 16
const REACH = RADIUS_CHUNKS * CHUNK_BLOCKS

/**
 * The console's commands run at the world spawn, so `~` is the spawn and the square needs no
 * coordinates read first: from 48 blocks before the spawn to 48 after, 7 chunks a side.
 */
const SQUARE = `~-${REACH} ~-${REACH} ~${REACH} ~${REACH}`
export const FORCELOAD_ADD = `forceload add ${SQUARE}`
export const FORCELOAD_REMOVE = `forceload remove ${SQUARE}`
const FORCELOAD_QUERY = 'forceload query'
/** Two opposite corners of the square, which an earlier attempt's force-load marks both. */
const CORNERS = [`forceload query ~-${REACH} ~-${REACH}`, `forceload query ~${REACH} ~${REACH}`]
const SQUARE_CHUNKS = (2 * RADIUS_CHUNKS + 1) ** 2

/** One `execute if loaded` per chunk of the square, at its spawn-relative block. */
const LOADED_CHECKS: readonly string[] = Array.from({ length: SQUARE_CHUNKS }, (_, i) => {
  const dx = ((i % (2 * RADIUS_CHUNKS + 1)) - RADIUS_CHUNKS) * CHUNK_BLOCKS
  const dz = (Math.floor(i / (2 * RADIUS_CHUNKS + 1)) - RADIUS_CHUNKS) * CHUNK_BLOCKS
  return `execute if loaded ~${dx} ~ ~${dz}`
})

/** How often the square is asked whether it is loaded. */
const ASKED_EVERY_MS = SECOND_MS
/**
 * Long past what the square takes on one CPU (about 20 s for a vanilla 26.x world); a pack whose
 * generation is slower still leaves with what it made, and the join makes the rest as before.
 */
const WAITED_AT_MOST_MS = 180 * SECOND_MS

/**
 * How many chunks `forceload query` says are force-loaded in the console's dimension, or null for
 * an answer it doesn't read: "No force loaded chunks were found in …", "A force loaded chunk was
 * found in …", "49 force loaded chunks were found in …".
 */
export function forcedCount(output: string): number | null {
  const said = output.trim()
  if (/^No force loaded chunks/i.test(said)) return 0
  if (/^A force loaded chunk/i.test(said)) return 1
  const many = /^(\d+) force loaded chunks/i.exec(said)
  return many === null ? null : Number(many[1])
}

/** Whether `forceload query <pos>` says that chunk is force-loaded. */
const marked = (output: string) => /is marked for force loading/i.test(output) && !/not marked/i.test(output)

/** Whether `execute if loaded` passed. */
const passed = (output: string) => /^Test passed/i.test(output.trim())

/** How many warm-ups a world gets, each cut short before it ran (by a change made at once, say). */
const QUEUED_AT_MOST = 3

/**
 * What `booted` asks before it saves what a server now runs over what it ran: the warm-up is queued
 * where the boot brought up a world the server didn't run before, a new server's or another switched
 * to (a fresh one, an import, or one played before, whose spawn is on disk and loads in a second),
 * and only where the game makes its spawn at the first join. A world has one that succeeds: one that
 * never got to run, because the server moved on to a change first, is queued again at the next boot
 * of the same world, a few times at most.
 */
export function warmingAfterBoot(transitions: Pick<ServerTransitions, 'enqueue'>) {
  return async (tx: Tx, serverId: string, config: Pick<AppliedConfigJson, 'worldId' | 'revisionId'>) => {
    const ops = schema.serverOperations
    const tries = await tx
      .select({ status: ops.status })
      .from(ops)
      .where(
        and(
          eq(ops.serverId, serverId),
          eq(ops.kind, 'warm_spawn'),
          like(ops.idempotencyKey, `warm_spawn:${config.worldId}%`),
        ),
      )
    if (
      tries.length >= QUEUED_AT_MOST ||
      tries.some((t) => t.status !== 'cancelled' && t.status !== 'failed')
    )
      return
    const [ran] = await tx
      .select({ applied: schema.serverRuntimes.applied })
      .from(schema.serverRuntimes)
      .where(eq(schema.serverRuntimes.serverId, serverId))
    if (tries.length === 0 && ran?.applied?.worldId === config.worldId) return
    const { gameVersion } = await loadRevisionFields(tx, config.revisionId, ['gameVersion'])
    if (compareVersions(gameVersion, SPAWN_AT_FIRST_JOIN) < 0) return
    const server = await findServer(tx, serverId)
    if (server === null) return
    await transitions.enqueue(tx, server, 'warm_spawn', {
      requestedBy: 'system:warm',
      idempotencyKey: `warm_spawn:${config.worldId}:${tries.length + 1}`,
    })
  }
}

/** Kept on the operation before its force-load goes on. */
const ADDING = 'spawn:forced'

/** What one attempt found and did, kept on the operation. */
type Found = 'players_on' | 'owner_forced' | 'unreadable' | 'ready' | 'unready'

export function warmingSpawn(deps: {
  db: Db
  console: Pick<ServerConsole, 'run' | 'runAll'>
  consoleTarget: GameConsole['consoleTarget']
  bindingOf: ServerBinding['bindingOf']
  /** How long the square is waited on, and how often it is asked; tests shorten them. */
  waitMs?: number
  pollMs?: number
}) {
  const { bindingOf } = deps
  const waitMs = deps.waitMs ?? WAITED_AT_MOST_MS
  const pollMs = deps.pollMs ?? ASKED_EVERY_MS

  /** Whether all of the square is loaded by `until`, asking only for what wasn't yet. */
  const loaded = async (target: ConsoleTarget, ctx: OperationContext, until: number): Promise<boolean> => {
    let left = [...LOADED_CHECKS]
    for (;;) {
      // Over one connection: the square is 49 commands a time.
      const answers = await deps.console.runAll(target, left)
      left = left.filter((_, i) => {
        const answer = answers[i]
        return answer === undefined || !answer.ok || !passed(answer.output)
      })
      if (left.length === 0) return true
      if (Date.now() >= until || ctx.signal.aborted) return false
      await sleep(pollMs, undefined, { signal: ctx.signal }).catch(() => undefined)
    }
  }

  /**
   * Whether a warm-up of this world said it was adding its square (`spawn:forced`) and never said
   * it took it off (`spawn:ready`, `spawn:unready`): an earlier attempt of this operation, or an
   * operation of the same world that failed before it could.
   */
  const leftBehind = async (ctx: OperationContext): Promise<boolean> => {
    const ops = schema.serverOperations
    const world = ctx.op.idempotencyKey.split(':')[1] ?? ctx.op.id
    const rows = await deps.db
      .select({ steps: ops.steps })
      .from(ops)
      .where(
        and(
          eq(ops.serverId, ctx.server.id),
          eq(ops.kind, 'warm_spawn'),
          like(ops.idempotencyKey, `warm_spawn:${world}%`),
        ),
      )
    return rows.some(({ steps }) => {
      const said = ((steps ?? []) as Array<{ step: string }>).map((s) => s.step)
      return said.includes(ADDING) && !said.includes('spawn:ready') && !said.includes('spawn:unready')
    })
  }

  /** Whether the force-load found is exactly the square: both corners of 49 chunks. */
  const square = async (target: ConsoleTarget, forced: number): Promise<boolean> => {
    if (forced !== SQUARE_CHUNKS) return false
    const corners = await Promise.all(CORNERS.map((query) => deps.console.run(target, query)))
    return corners.every(marked)
  }

  /**
   * Before the force-load goes on: what keeps it off, or null to go ahead. A square found is taken
   * off (`resume`) only where a warm-up of this world left one; any other force-load is the owner's,
   * whatever its shape.
   */
  const keptOff = async (target: ConsoleTarget, left: boolean): Promise<Found | 'resume' | null> => {
    const forced = forcedCount(await deps.console.run(target, FORCELOAD_QUERY))
    if (forced === null) return 'unreadable'
    if (forced > 0) return left && (await square(target, forced)) ? 'resume' : 'owner_forced'
    const online = parseOnlinePlayers(await deps.console.run(target, LIST_UUIDS))
    if (online === null) return 'unreadable'
    return online.online > 0 ? 'players_on' : null
  }

  /** Takes the square off and checks it is gone: one left behind would load on every boot. */
  const takeOff = async (target: ConsoleTarget): Promise<void> => {
    await deps.console.run(target, FORCELOAD_REMOVE)
    const corners = await Promise.all(CORNERS.map((query) => deps.console.run(target, query)))
    if (corners.some(marked)) throw new Error('The spawn’s force-load is still on after taking it off')
  }

  const warmSpawn: OperationHandler = {
    kind: 'warm_spawn',
    phase: null,
    runsWhen: ['running'],
    async run(ctx) {
      const { handle } = await bindingOf(ctx.server.id)
      if (handle === null) return { status: 'succeeded' }
      const target = deps.consoleTarget(ctx.server, handle)
      const left = await leftBehind(ctx)
      // Before anything is added, a console that doesn't answer leaves the world as it was: the
      // join makes the spawn, as it always has. After a square may have gone on, it fails, and is
      // tried again until the square is off.
      const before = await keptOff(target, left).catch((error: unknown): Found => {
        if (left) throw error
        return 'unreadable'
      })
      if (before !== null && before !== 'resume') {
        await ctx.mark(`spawn:${before}`)
        return { status: 'succeeded' }
      }
      const until = Date.now() + waitMs
      let found: Found = 'unready'
      try {
        if (before === null) {
          // Said first: a later attempt takes a square off only where this was said.
          await ctx.mark(ADDING)
          await deps.console.run(target, FORCELOAD_ADD)
        }
        found = (await loaded(target, ctx, until)) ? 'ready' : 'unready'
      } finally {
        // Also where the add went unanswered: it may have gone on all the same.
        await takeOff(target)
      }
      await ctx.mark(`spawn:${found}`)
      return { status: 'succeeded' }
    },
  }

  return warmSpawn
}
