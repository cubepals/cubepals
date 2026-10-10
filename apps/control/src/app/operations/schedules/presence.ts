// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Records who is online on each running server, read from the server's own console, and delivers
 * an access change, or what the owner asked for on a player's page, waiting for someone who has
 * just joined. A console that stops or starts answering again also marks or clears a lost host. Stopping a server nobody is on is `idle.ts`'s;
 * rebuilding one off a lost host is `relocations.ts`'s.
 */
import type { Db } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { LIST_UUIDS, parseOnlinePlayers } from '../../../minecraft/console.ts'
import { PORT_NAMES } from '../../../minecraft/runtime-spec.ts'
import { readAccess } from '../../access/persistence.ts'
import { playersSeen } from '../../insight/record.ts'
import type { PlayerService } from '../../players/service.ts'
import type { EventBus } from '../../ports/events.ts'
import type { ServerConsole } from '../../ports/minecraft.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { HOST_LOST, listByStatus, loadRuntime, saveObserved } from '../../servers/persistence.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { type PresentPlayer, recordPlay, replacePresence } from '../../servers/usage.ts'
import { observedJson, recordHostLost } from './observations.ts'

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
    for (const server of await listByStatus(db, 'running')) {
      const { handle, observed, provider } = await loadRuntime(db, server.id, runtime.providers)
      if (handle === null) continue
      const target = {
        endpoint: runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
        passwords: specs.rconPasswords(server.id),
      }
      const output = await deps.console.run(target, LIST_UUIDS).catch(() => null)
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
            idempotencyKey: `access_join:${Math.floor(now.getTime() / 60_000)}`,
          })
      })
      await deliverWaiting(server, handle, reading.players)
    }
  }

  return presenceSync
}
