// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Takes a server down: stopped (its world saved and measured first), or asleep with its memory
 * kept where its runtime can and nothing is about to change, and a restore point of the session
 * queued after a sleep; decommissioned into the trash with its storage kept; or purged for good. Each ends what the server is billed for and who is on it. Saving
 * through the console is `game-console.ts`'s; when a server is purged is the purge sweep's
 * (`schedules.ts`).
 */
import { type AppliedConfigJson, type Db, type Queryable, schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { entitlementsFor, grownDisk } from '../../../domain/account/entitlements.ts'
import type { StopReason } from '../../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { DATA_DIR } from '../../../minecraft/jars.ts'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import { requestedBy } from '../../actor.ts'
import { latestRestorePoint } from '../../backups/persistence.ts'
import { forgetPlayers } from '../../players/persistence.ts'
import type { PlayerService } from '../../players/service.ts'
import type { ReadinessProbe } from '../../ports/minecraft.ts'
import { type RuntimeHandle, runtimeKey } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import {
  grownStorage,
  lockServer,
  recordDisk,
  saveHandle,
  saveMemoryKept,
} from '../../servers/persistence.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { clearPresence, closeInterval, lastActivity } from '../../servers/usage.ts'
import type { OperationHandler, OperationResult } from '../runner.ts'
import type { ServerBinding } from './binding.ts'
import type { GameConsole } from './game-console.ts'

/**
 * The stops that put a server to sleep: nobody played for a while, or a woken one nobody joined
 * (both `idle`), or its owner's, or the end of the day's play (`daily`), which a join wakes from
 * once midnight comes. Every other stop comes before a change, or ends play for a reason of its
 * own, and takes a real stop.
 */
const SLEEPS: ReadonlySet<StopReason> = new Set(['idle', 'user', 'daily'])

/** Who the idle check's stops are requested by. */
const IDLE_ACTOR = requestedBy({ kind: 'system', reason: 'idle' })

/** A server's game port as the control plane pings it, and whether the run it is in reads a PROXY header. */
const gameOf = (
  runtime: Pick<Runtimes, 'endpoint'>,
  handle: RuntimeHandle,
  booted: AppliedConfigJson | null,
) => ({
  ...runtime.endpoint(handle, PORT_NAMES.game, 'control'),
  proxyProtocol: booted?.proxyProtocol,
})

/** How many are on the server, as the game says now; null when it doesn't answer. */
async function playersOn(probe: Pick<ReadinessProbe, 'ping'>, game: Parameters<ReadinessProbe['ping']>[0]) {
  const status = await probe.ping(game, AbortSignal.timeout(5_000)).catch(() => null)
  return status?.online ?? null
}

/** Whether anyone is on the server, as the game says now. */
const joined = async (probe: Pick<ReadinessProbe, 'ping'>, game: Parameters<ReadinessProbe['ping']>[0]) =>
  ((await playersOn(probe, game)) ?? 0) > 0

/** An idle stop called off: the server goes back to running, as it was before it was asked. */
async function keep(
  db: Db,
  transitions: Pick<ServerTransitions, 'outcome'>,
  serverId: string,
): Promise<OperationResult> {
  await db.transaction(async (tx) => {
    const locked = await lockServer(tx, serverId)
    if (locked?.lifecycle.status === 'stopping') await transitions.outcome(tx, locked, { type: 'kept' })
  })
  return { status: 'cancelled', reason: 'Someone joined, so it stayed on.' }
}

/** Whether a player was seen since the server's newest restore point: what a new one would hold. */
async function playedSinceRestorePoint(q: Queryable, serverId: string): Promise<boolean> {
  const [played, last] = [await lastActivity(q, serverId), await latestRestorePoint(q, serverId)]
  return played !== null && (last === null || played > last.createdAt)
}

export function windingDown(deps: {
  db: Db
  runtime: Pick<
    Runtimes,
    'stop' | 'sleeps' | 'sleep' | 'forceStop' | 'decommission' | 'destroy' | 'exec' | 'endpoint'
  >
  probe: Pick<ReadinessProbe, 'ping'>
  transitions: Pick<ServerTransitions, 'outcome' | 'enqueue'>
  bindingOf: ServerBinding['bindingOf']
  windDown: GameConsole['windDown']
  players: Pick<PlayerService, 'snapshot'>
}) {
  const { db, runtime, transitions, bindingOf, windDown } = deps

  /**
   * What the world takes on disk, read while the server still runs, just saved: what
   * a resting copy costs, and whether the next start needs a bigger disk. Best effort: a server
   * that won't answer stops all the same.
   */
  const measureDisk = async (server: MinecraftServer, handle: RuntimeHandle) => {
    const read = await runtime.exec(handle, ['du', '-sk', DATA_DIR], 60).catch(() => null)
    if (read === null || read.exitCode !== 0) return
    const kilobytes = Number.parseInt(read.stdout.trim().split(/\s+/)[0] ?? '', 10)
    if (!Number.isFinite(kilobytes)) return
    const usedBytes = kilobytes * 1024
    const standing = await loadStanding(db, server.ownerId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    const current = Math.max(plan.storage.startGb, await grownStorage(db, server.id))
    await recordDisk(db, server.id, usedBytes, new Date(), grownDisk(plan, current, usedBytes) ?? undefined)
  }

  /**
   * Whether a server just saved may sleep with its memory kept rather than stop: nobody on it, as
   * the game says now (one who joined since the stop was asked would be frozen with it, where a
   * stop at least says goodbye), and its files written through to its storage, since the provider
   * may drop the memory it kept and boot from there.
   */
  const mayDoze = async (handle: RuntimeHandle, booted: AppliedConfigJson | null) => {
    if ((await playersOn(deps.probe, gameOf(runtime, handle, booted))) !== 0) return false
    const synced = await runtime.exec(handle, ['sync'], 60).catch(() => null)
    return synced?.exitCode === 0
  }

  const stop: OperationHandler = {
    kind: 'stop',
    phase: 'stopping',
    runsWhen: ['stopping'],
    async run(ctx) {
      const server = ctx.server
      const { handle, applied } = await bindingOf(server.id)
      const reason = (ctx.op.input.reason as StopReason | undefined) ?? 'user'
      if (handle !== null) {
        // Someone may have joined since the idle check read nobody on: a server anyone is on stays up.
        if (ctx.op.requestedBy === IDLE_ACTOR && (await joined(deps.probe, gameOf(runtime, handle, applied))))
          return keep(db, transitions, server.id)
        await ctx.step('saving')
        const saved = await windDown(server, handle)
        await measureDisk(server, handle)
        // One more exec, while the files are just saved and still cheap to read.
        await deps.players.snapshot(server, handle).catch(() => undefined)
        await ctx.step('stopping')
        // Asleep only once the world is saved: unsaved, a stop saves it on the way down.
        if (SLEEPS.has(reason) && runtime.sleeps(handle) && saved && (await mayDoze(handle, applied)))
          await saveMemoryKept(db, server.id, (await runtime.sleep(handle)) === 'suspended')
        else await runtime.stop(handle)
      }
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null || locked.lifecycle.status !== 'stopping') return
        await closeInterval(tx, server.id, new Date())
        await clearPresence(tx, server.id)
        const stopped = await transitions.outcome(tx, locked, { type: 'stopped', reason })
        // A restore point of the session that just ended, taken once the server is down so nobody's
        // hours pay for it. A wake nobody joined changed nothing, and takes none.
        if (handle === null || !SLEEPS.has(reason) || !(await playedSinceRestorePoint(tx, server.id))) return
        await transitions.enqueue(tx, stopped, 'backup', {
          requestedBy: 'system:sleep',
          idempotencyKey: `backup:sleep:${ctx.op.id}`,
          input: { trigger: 'sleep' },
        })
      })
      return { status: 'succeeded' }
    },
    /** A stop that failed for good is forced (§9): nothing runs on that nobody asked for. */
    async abandon(op, _reason, ended) {
      if (ended !== 'failed') return
      const { handle } = await bindingOf(op.serverId)
      if (handle === null) return
      await runtime.forceStop(handle)
      // Off is off: its time stops counting and nobody is on it.
      await db.transaction(async (tx) => {
        await closeInterval(tx, op.serverId, new Date())
        await clearPresence(tx, op.serverId)
      })
    },
  }

  const decommission: OperationHandler = {
    kind: 'decommission',
    phase: null,
    runsWhen: ['deleted'],
    async run(ctx) {
      const server = ctx.server
      const { handle } = await bindingOf(server.id)
      if (handle !== null) {
        await windDown(server, handle)
        await runtime.decommission(handle)
      }
      await db.transaction(async (tx) => {
        await closeInterval(tx, server.id, new Date())
        await clearPresence(tx, server.id)
      })
      return { status: 'succeeded' }
    },
  }

  const purge: OperationHandler = {
    kind: 'purge',
    phase: null,
    runsWhen: ['deleted'],
    async run(ctx) {
      const server = ctx.server
      const { handle, provider } = await bindingOf(server.id)
      await runtime.destroy(provider, handle ?? runtimeKey(server.id))
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked === null || locked.lifecycle.status !== 'deleted') return
        await saveHandle(tx, server.id, null)
        await tx.delete(schema.serverAccessEntries).where(eq(schema.serverAccessEntries.serverId, server.id))
        await tx
          .delete(schema.serverModerationActions)
          .where(eq(schema.serverModerationActions.serverId, server.id))
        // Who played there goes with who could: with the server gone, nothing needs their names.
        await tx.delete(schema.serverPlayers).where(eq(schema.serverPlayers.serverId, server.id))
        await forgetPlayers(tx, server.id)
        // Its guestbook too: the notes were about a server that is no longer anywhere.
        await tx.delete(schema.serverStars).where(eq(schema.serverStars.serverId, server.id))
        await tx.delete(schema.serverNotes).where(eq(schema.serverNotes.serverId, server.id))
        // And the pictures its owner gave it.
        await tx.delete(schema.serverIcons).where(eq(schema.serverIcons.serverId, server.id))
        // The provider's snapshots went with everything else.
        await tx
          .update(schema.backups)
          .set({ status: 'deleted' })
          .where(and(eq(schema.backups.serverId, server.id), eq(schema.backups.tier, 'snapshot')))
        // So does the copy a world rested in: it was the server's world, not a download of it,
        // and the store lets it go at the next sweep.
        await tx
          .update(schema.backups)
          .set({ status: 'deleted' })
          .where(and(eq(schema.backups.serverId, server.id), eq(schema.backups.trigger, 'stored')))
        await transitions.outcome(tx, locked, { type: 'purged' })
      })
      return { status: 'succeeded' }
    },
  }

  return { stop, decommission, purge }
}
