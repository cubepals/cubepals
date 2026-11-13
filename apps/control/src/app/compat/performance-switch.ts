// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The owner's switch for the performance mods Cubepals adds to a Fabric server (`performance.ts`):
 * on or off, kept beside the server, and audited as its idle kick is (`servers/afk-kick.ts`).
 *
 * It makes no revision and starts, stops or restarts nothing. A start places the mods or leaves
 * them out (`servers/specs.ts`), so a running server has the change at its next start, and nobody
 * playing is interrupted for mods that only make the game cheaper to run. Only the server's version
 * moves, so its pages read it again.
 *
 * What the settings page shows of them is `performance-view.ts`'s.
 */
import { type Db, schema } from '@blockly/db'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import { lockServer, setDesired } from '../servers/persistence.ts'
import { loadRevisionFields } from '../servers/revision-reads.ts'
import { performanceOff, setPerformance, takesPerformance } from './performance.ts'

/** What a server they are not for is told. */
const NOT_FOR = 'Cubepals adds performance mods only to Fabric servers without a modpack.'

export class PerformanceSwitch {
  readonly #db: Db
  readonly #events: EventBus

  constructor(db: Db, events: EventBus) {
    this.#db = db
    this.#events = events
  }

  /**
   * Turns them on or off for the server's next start, as its owner's choice: turning them on is
   * also the way back from a start that turned them off (`clash`). A press that leaves the choice
   * as it was changes and records nothing.
   */
  async set(actor: Actor, serverId: string, on: boolean): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const locked = authorize(actor, await lockServer(tx, serverId))
      if (locked.deletedAt !== null) throw new NotFound('Server')
      const revision = await loadRevisionFields(tx, locked.desiredRevisionId, ['loader', 'modpack'])
      if (!takesPerformance(revision)) throw new AppError('invalid_choice', NOT_FOR)
      const was = await performanceOff(tx, serverId)
      if (on ? was === null : was === 'owner') return
      await setPerformance(tx, serverId, on, 'owner')
      const server = await setDesired(tx, locked, {})
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: on ? 'server.performance_mods_on' : 'server.performance_mods_off',
        subjectType: 'server',
        subjectId: serverId,
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
