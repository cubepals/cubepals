// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An owner's switch for something Cubepals adds as a server starts, kept beside the server rather
 * than in a revision: the performance mods (`compat/performance-switch.ts`) and Offline world
 * progression (`progression/switch.ts`). It makes no revision and starts, stops or restarts
 * nothing: a start places what is on or leaves it out (`servers/specs.ts`). A change moves the
 * server's version, so its pages read it again, is audited as its owner's, and its watchers hear
 * of it. A press that leaves the choice as it was changes and records nothing.
 *
 * What each switch keeps, and which servers it is for, is its own (`Switched`).
 */
import { type Db, schema, type Tx } from '@blockly/db'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import { lockServer, setDesired } from './persistence.ts'

/** One switch: what it reads and keeps, and how its changes are audited. */
export interface Switched {
  /** Whether a server on this revision takes it at all. */
  takes(tx: Tx, revisionId: string): Promise<boolean>
  /** What the owner of a server it isn't for is told. */
  notFor: string
  /** Why the server runs without it: its owner's switch, a start that failed with it, or null for on. */
  off(tx: Tx, serverId: string): Promise<'owner' | 'clash' | null>
  set(tx: Tx, serverId: string, on: boolean): Promise<void>
  audited: { on: string; off: string }
}

export class OwnerSwitch {
  readonly #db: Db
  readonly #events: EventBus
  readonly #switched: Switched

  constructor(db: Db, events: EventBus, switched: Switched) {
    this.#db = db
    this.#events = events
    this.#switched = switched
  }

  /**
   * Turns it on or off for the server's next start, as its owner's choice: turning it on is also
   * the way back from a start that turned it off (`clash`).
   */
  set(actor: Actor, serverId: string, on: boolean): Promise<void> {
    const switched = this.#switched
    return this.change(actor, serverId, async (tx) => {
      const was = await switched.off(tx, serverId)
      if (on ? was === null : was === 'owner') return null
      await switched.set(tx, serverId, on)
      return { action: on ? switched.audited.on : switched.audited.off }
    })
  }

  /**
   * One change of the owner's to the server: locked, theirs, not deleted and one the switch is
   * for; `apply` makes the change and says what to audit, or null where nothing changed, which
   * then records nothing. A change moves the server's version and its watchers hear of it.
   */
  protected async change(
    actor: Actor,
    serverId: string,
    apply: (tx: Tx) => Promise<{ action: string; data?: Record<string, unknown> } | null>,
  ): Promise<void> {
    const switched = this.#switched
    await this.#db.transaction(async (tx) => {
      const locked = authorize(actor, await lockServer(tx, serverId))
      if (locked.deletedAt !== null) throw new NotFound('Server')
      if (!(await switched.takes(tx, locked.desiredRevisionId)))
        throw new AppError('invalid_choice', switched.notFor)
      const changed = await apply(tx)
      if (changed === null) return
      const server = await setDesired(tx, locked, {})
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: changed.action,
        subjectType: 'server',
        subjectId: serverId,
        ...(changed.data === undefined ? {} : { data: changed.data }),
      })
      await this.#events.publish(tx, {
        type: 'server_changed',
        serverId,
        ownerId: server.ownerId,
        status: server.lifecycle.status,
        version: server.version,
      })
    })
  }
}
