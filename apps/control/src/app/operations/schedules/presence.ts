// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Records who is online on each running server, read from the server's own console, and delivers
 * an access change, or what the owner asked for on a player's page, waiting for someone who has
 * just joined. The same reading tells each open join whether its player was on the list
 * (`joins/player-list.ts`). A console that stops or starts answering again also marks or clears a lost host.
 * On the same connection it reads how a server ticks (`tick query`) where the reporter plugin
 * doesn't sample it, which `vitals/console-samples.ts` keeps, and says an operator's notice on its
 * owner to the players on it (`notice-said.ts`). Stopping a server nobody is on is `idle.ts`'s;
 * rebuilding one off a lost host is `relocations.ts`'s.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import {
  LIST_UUIDS,
  parseOnlinePlayers,
  parseTickQuery,
  TICK_QUERY,
  type TickReading,
} from '../../../minecraft/console.ts'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import { readAccess } from '../../access/persistence.ts'
import { noticesOf } from '../../accounts/notice.ts'
import { playersSeen } from '../../insight/record.ts'
import { type ListReading, noteListed } from '../../joins/player-list.ts'
import type { PlayerService } from '../../players/service.ts'
import type { EventBus } from '../../ports/events.ts'
import type { ConsoleTarget, ServerConsole } from '../../ports/minecraft.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { HOST_LOST, listByStatus, saveObserved } from '../../servers/persistence.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { type PresentPlayer, recordPlay, replacePresence } from '../../servers/usage.ts'
import { recordConsoleTick, reportingServers } from '../../vitals/console-samples.ts'
import { sayNotice } from './notice-said.ts'
import { observedJson, recordHostLost } from './observations.ts'
import { placementsOf } from './placements.ts'

/**
 * `list uuids`, and `tick query` after it on the same connection when the server's ticks are read
 * here; null for what didn't answer.
 */
async function readConsole(
  console: ServerConsole,
  target: ConsoleTarget,
  ticks: boolean,
): Promise<{ output: string | null; tick: TickReading | null }> {
  if (!ticks) return { output: await console.run(target, LIST_UUIDS).catch(() => null), tick: null }
  const [list, tick] = await console.runAll(target, [LIST_UUIDS, TICK_QUERY]).catch(() => [])
  return { output: list?.ok ? list.output : null, tick: tick?.ok ? parseTickQuery(tick.output) : null }
}

/**
 * Tells the joins what the list read at `readAt` said of their players (`joins/player-list.ts`),
 * by when the server answered and not by when the pass got round to saying it: a player who left
 * in between was still seen, and a mark timed after their leaving would be taken back as late. It
 * is a record for operators, so a failure to keep it is only logged, and the pass goes on.
 */
async function tellJoins(db: Db, serverId: string, reading: ListReading, readAt: Date): Promise<void> {
  await noteListed(db, serverId, reading, readAt).catch((error: unknown) =>
    console.warn('listed joins', serverId, error instanceof Error ? error.message : error),
  )
}

/** Keeps a console's tick reading, if it gave one; a failure to keep it is only logged. */
async function keepTick(db: Db, serverId: string, tick: TickReading | null, players: number): Promise<void> {
  if (tick === null) return
  await recordConsoleTick(db, serverId, tick, players).catch((error: unknown) =>
    console.warn('console ticks', serverId, error instanceof Error ? error.message : error),
  )
}

export function readingPresence(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'endpoint' | 'observe'>
  console: ServerConsole
  specs: Pick<RuntimeSpecs, 'rconPasswords'>
  events: Pick<EventBus, 'publish'>
  transitions: Pick<ServerTransitions, 'enqueue'>
  players: Pick<PlayerService, 'deliverWaiting'>
}) {
  const { db, runtime, specs, events, transitions } = deps

  /** Back to where they died, a game mode: asked for while they were away, done now they're here. */
  const deliverWaiting = async (server: MinecraftServer, handle: RuntimeHandle, players: PresentPlayer[]) => {
    if (players.length === 0) return
    await deps.players
      .deliverWaiting(server, handle, players)
      .catch((error: unknown) =>
        console.warn('player actions', server.id, error instanceof Error ? error.message : error),
      )
  }

  /** Who is online, read from each running server itself. */
  const presenceSync = async (): Promise<void> => {
    const running = await listByStatus(db, 'running')
    const placementOf = await placementsOf(
      db,
      running.map((s) => s.id),
      runtime.providers,
    )
    const sampled = await reportingServers(
      db,
      running.map((s) => s.id),
    )
    const notices = await noticesOf(
      db,
      running.map((s) => s.ownerId),
    )
    for (const server of running) {
      const { handle, observed, provider } = placementOf(server.id)
      if (handle === null) continue
      const target = {
        endpoint: runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
        passwords: specs.rconPasswords(server.id),
      }
      const { output, tick } = await readConsole(deps.console, target, !sampled.has(server.id))
      const readAt = new Date()
      if (output === null && observed?.detail !== HOST_LOST) {
        // A console that stopped answering may be a lost host, which the provider's list doesn't
        // say: this one machine is asked.
        const seen = await runtime.observe(handle).catch(() => null)
        if (seen?.hostLost) await recordHostLost(db, server.id, seen)
      }
      if (output !== null && observed?.detail === HOST_LOST) {
        // Answering again, the host is back: the mark goes before a rebuild would act on it.
        const seen = await runtime.observe(handle).catch(() => null)
        if (seen !== null && !seen.hostLost) await saveObserved(db, server.id, observedJson(seen))
      }
      const reading = output === null ? null : parseOnlinePlayers(output)
      if (reading === null) continue
      await keepTick(db, server.id, tick, reading.online)
      await db.transaction(async (tx) => {
        const now = new Date()
        await replacePresence(tx, server.id, reading.players, now)
        await recordPlay(tx, server.id, provider, reading.online, now)
        if (reading.players.length > 0)
          await playersSeen(
            tx,
            server.id,
            reading.players.map((p) => p.name),
            now,
          )
        await events.publish(tx, {
          type: 'presence',
          serverId: server.id,
          ownerId: server.ownerId,
          online: reading.online,
        })
        // A change still waiting for someone who is on now: the server knows their name as theirs
        // once they have joined (§15.1), so it is delivered while they are here.
        const { record } = await readAccess(tx, server.id)
        const here = new Set(reading.players.map((p) => p.name.toLowerCase()))
        const waiting = record.entries.some(
          (e) =>
            (e.state === 'pending_add' || e.state === 'pending_remove') &&
            here.has(e.player.name.toLowerCase()),
        )
        if (waiting)
          await transitions.enqueue(tx, server, 'access_sync', {
            requestedBy: 'system:access',
            idempotencyKey: `access_join:${Math.floor(now.getTime() / MINUTE_MS)}`,
          })
      })
      await tellJoins(db, server.id, reading, readAt)
      await deliverWaiting(server, handle, reading.players)
      const notice = notices.get(server.ownerId)
      await sayNotice({ db, console: deps.console }, { id: server.id, target }, notice, reading.players)
    }
  }

  return presenceSync
}
