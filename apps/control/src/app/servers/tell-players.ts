// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The owner's choice, for one server, whether a player is told in chat when the owner acts on them
 * from their page (`app/players/telling.ts` says what they are told). On until the owner turns it
 * off; it takes effect with the next action, and needs no restart. Saved and audited as the idle
 * kick is (`afk-kick.ts`).
 */
import { type Db, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { NotFound } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import { lockServer } from './persistence.ts'

export class TellPlayers {
  readonly #db: Db
  readonly #events: EventBus

  constructor(db: Db, events: EventBus) {
    this.#db = db
    this.#events = events
  }

  async set(actor: Actor, serverId: string, tell: boolean): Promise<void> {
    if (actor.kind !== 'user') throw new NotFound('Server')
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (server.deletedAt !== null) throw new NotFound('Server')
      if (server.tellPlayers === tell) return
      const version = server.version + 1
      await tx
        .update(schema.minecraftServers)
        .set({ tellPlayers: tell, version, updatedAt: new Date() })
        .where(eq(schema.minecraftServers.id, server.id))
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'server.tell_players_set',
        subjectType: 'server',
        subjectId: server.id,
        data: { tell },
      })
      await this.#events.publish(tx, {
        type: 'server_changed',
        serverId: server.id,
        ownerId: server.ownerId,
        status: server.lifecycle.status,
        version,
      })
    })
  }
}
