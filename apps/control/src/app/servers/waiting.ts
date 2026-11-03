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
import { describeChanges, type ServerSettings } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { type MemoryTier, sizeLabel } from '../../domain/server/size.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import { saveStopCheaters } from '../stop-cheaters/persistence.ts'
import { stopCheatersWaiting } from '../stop-cheaters/waiting.ts'
import { insertRevision, loadRevision, lockServer, setDesired } from './persistence.ts'
import { loadApplied, showsAtNextStart } from './restart-wait.ts'
import { loadChangeFacts, loadRevisionFields } from './revision-reads.ts'
import type { ServerTransitions } from './transitions.ts'

/**
 * What waits on a running server for everyone to leave; null where nothing does. The server list's
 * message isn't among it: it shows from the next start, whoever is on (`showsAtNextStart`).
 */
export async function waitingChanges(
  q: Queryable,
  server: MinecraftServer,
  applied: AppliedConfigJson | null,
): Promise<WaitingChangesView | null> {
  if (server.lifecycle.status !== 'running' || applied === null) return null
  const changes =
    applied.revisionId === server.desiredRevisionId
      ? []
      : await restartChanges(q, applied.revisionId, server.desiredRevisionId)
  const size =
    applied.memoryTier === server.memoryTier
      ? null
      : { from: sizeLabel(applied.memoryTier as MemoryTier), to: sizeLabel(server.memoryTier) }
  const stopCheaters = await stopCheatersWaiting(q, server, applied)
  if (changes.length === 0 && size === null && stopCheaters === null) return null
  return { changes, size, stopCheaters }
}

/** What running `to` where `from` runs changes that a restart brings: all of it but what only the server list shows. */
async function restartChanges(q: Queryable, from: string, to: string) {
  const after = await loadChangeFacts(q, to)
  return describeChanges(await loadChangeFacts(q, from), after).filter(
    (change) => !showsAtNextStart(change.field, after.gameVersion),
  )
}

/**
 * The revision dropping what waits goes back to: the one the server booted, or, where the message
 * it should show from its next start differs from that one's, a revision going back to it with
 * that message kept. A message in Cubepals' words that followed a new name so goes on following it.
 */
async function keptMessage(tx: Tx, server: MinecraftServer, applied: AppliedConfigJson, by: string) {
  const ran = await loadRevision(tx, applied.revisionId)
  const { settings, gameVersion } = await loadRevisionFields(tx, server.desiredRevisionId, [
    'settings',
    'gameVersion',
  ])
  const kept = Object.entries(settings).filter(
    ([field, value]) =>
      showsAtNextStart(field, gameVersion) && ran.settings[field as keyof ServerSettings] !== value,
  )
  if (kept.length === 0) return ran.id
  const { id: _id, serverId: _serverId, number: _number, createdBy: _createdBy, ...draft } = ran
  const revision = await insertRevision(
    tx,
    server.id,
    {
      ...draft,
      settings: { ...ran.settings, ...Object.fromEntries(kept) },
      reason: 'rollback',
      basedOnRevisionId: ran.id,
    },
    by,
  )
  return revision.id
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
          : await this.#cancel(tx, server, waiting, applied, requestedBy(actor))
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

  /**
   * The configuration and size go back to what booted first, with the server list's message kept,
   * which never waited (`keptMessage`). Stop cheaters is then compared with what runs again, and
   * the switch goes back only where it still differs: a waiting version that merely made Grim
   * available or not leaves the owner's switch as they set it.
   */
  async #cancel(
    tx: Tx,
    server: MinecraftServer,
    waiting: WaitingChangesView,
    applied: AppliedConfigJson,
    by: string,
  ): Promise<MinecraftServer> {
    const back =
      waiting.changes.length === 0 && waiting.size === null
        ? server
        : await setDesired(tx, server, {
            revisionId: await keptMessage(tx, server, applied, by),
            memoryTier: applied.memoryTier as MemoryTier,
          })
    const still = await stopCheatersWaiting(tx, back, applied)
    if (still === 'ours') await saveStopCheaters(tx, server.id, { takeOver: false })
    else if (still !== null)
      await saveStopCheaters(tx, server.id, {
        setting: still === 'on' ? 'off' : 'on',
        reason: null,
        takeOver: false,
      })
    return back
  }
}
