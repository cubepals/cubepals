// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An owner's change that waits for everyone to leave a running server, rather than restarting it
 * under its players. The change is saved as what the server should run, as any is; only the
 * restart waits. Drift (`operations/schedules/drift.ts`) brings it once nobody is on, a stop brings
 * it at the next start, and the owner can take it now or drop it from the server's page.
 *
 * Here: what waits, as the page shows it (`waitingChanges`), and the owner's two ways out of it
 * (`WaitingChanges`). Whether a change waits is `restart-wait.ts`'s; making it is each service's
 * own (`revisions/service.ts`, `stop-cheaters/service.ts`).
 */
import type { WaitingChangesView } from '@blockly/contracts'
import { type AppliedConfigJson, type Db, type Queryable, schema, type Tx } from '@blockly/db'
import { describeChanges } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { type MemoryTier, sizeLabel } from '../../domain/server/size.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import { saveStopCheaters } from '../stop-cheaters/persistence.ts'
import { stopCheatersWaiting } from '../stop-cheaters/waiting.ts'
import { lockServer, setDesired } from './persistence.ts'
import { loadApplied } from './restart-wait.ts'
import { loadChangeFacts } from './revision-reads.ts'
import type { ServerTransitions } from './transitions.ts'

/** What waits on a running server for everyone to leave; null where nothing does. */
export async function waitingChanges(
  q: Queryable,
  server: MinecraftServer,
  applied: AppliedConfigJson | null,
): Promise<WaitingChangesView | null> {
  if (server.lifecycle.status !== 'running' || applied === null) return null
  const changes =
    applied.revisionId === server.desiredRevisionId
      ? []
      : describeChanges(
          await loadChangeFacts(q, applied.revisionId),
          await loadChangeFacts(q, server.desiredRevisionId),
        )
  const size =
    applied.memoryTier === server.memoryTier
      ? null
      : { from: sizeLabel(applied.memoryTier as MemoryTier), to: sizeLabel(server.memoryTier) }
  const stopCheaters = await stopCheatersWaiting(q, server, applied)
  if (changes.length === 0 && size === null && stopCheaters === null) return null
  return { changes, size, stopCheaters }
}

const NOTHING_WAITS = 'Nothing is waiting for the server any more.'

/** The owner's ways out of a waiting change: take it now, restarting the server, or drop it. */
export class WaitingChanges {
  readonly #db: Db
  readonly #transitions: ServerTransitions
  readonly #events: EventBus

  constructor(deps: {
    db: Db
    transitions: ServerTransitions
    events: EventBus
  }) {
    this.#db = deps.db
    this.#transitions = deps.transitions
    this.#events = deps.events
  }

  /**
   * `now`: the server restarts into what waits, its players warned first. `cancel`: what waits is
   * dropped, and the server keeps what it runs: the configuration and size it booted, and Stop
   * cheaters as it booted it.
   */
  async settle(actor: Actor, serverId: string, settle: 'now' | 'cancel', requestId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      const applied = await loadApplied(tx, server.id)
      const waiting = await waitingChanges(tx, server, applied)
      if (waiting === null || applied === null) throw new AppError('invalid_choice', NOTHING_WAITS)
      const settled =
        settle === 'now'
          ? await this.#now(tx, server, waiting, requestId, requestedBy(actor))
          : await this.#cancel(tx, server, waiting, applied)
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: settle === 'now' ? 'server.waiting_applied' : 'server.waiting_cancelled',
        subjectType: 'server',
        subjectId: server.id,
      })
      await this.#events.publish(tx, {
        type: 'server_changed',
        serverId: settled.id,
        ownerId: settled.ownerId,
        status: settled.lifecycle.status,
        version: settled.version,
      })
    })
  }

  async #now(
    tx: Tx,
    server: MinecraftServer,
    waiting: WaitingChangesView,
    requestId: string,
    by: string,
  ): Promise<MinecraftServer> {
    const { server: moved } = await this.#transitions.command(
      tx,
      server,
      { type: 'apply' },
      {
        requestedBy: by,
        idempotencyKey: `apply:${requestId}`,
        // Stop cheaters changes nothing the configuration says, so the server boots for it.
        input: { revisionId: server.desiredRevisionId, ...(waiting.stopCheaters ? { boot: true } : {}) },
      },
    )
    return moved
  }

  async #cancel(
    tx: Tx,
    server: MinecraftServer,
    waiting: WaitingChangesView,
    applied: AppliedConfigJson,
  ): Promise<MinecraftServer> {
    if (waiting.stopCheaters === 'ours') await saveStopCheaters(tx, server.id, { takeOver: false })
    else if (waiting.stopCheaters !== null)
      await saveStopCheaters(tx, server.id, {
        setting: waiting.stopCheaters === 'on' ? 'off' : 'on',
        reason: null,
        takeOver: false,
      })
    if (waiting.changes.length === 0 && waiting.size === null) return server
    return setDesired(tx, server, {
      revisionId: applied.revisionId,
      memoryTier: applied.memoryTier as MemoryTier,
    })
  }
}
