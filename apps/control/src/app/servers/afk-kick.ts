// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The owner's idle-kick choice for one server. It survives a world restore and takes effect at
 * the next start, like the plan's default; saving never interrupts players or changes another
 * server. RuntimeSpecs reads the choice, and the account's old value is migration data only.
 */
import { SetAfkKickInput } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsOf } from '../../domain/account/entitlements.ts'
import { loadStanding, lockStanding } from '../accounts/persistence.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import { lockServer } from './persistence.ts'

export class AfkKick {
  readonly #db: Db
  readonly #events: EventBus

  constructor(db: Db, events: EventBus) {
    this.#db = db
    this.#events = events
  }

  async set(actor: Actor, serverId: string, minutes: number | null): Promise<void> {
    if (actor.kind !== 'user') throw new NotFound('Server')
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (server.deletedAt !== null) throw new NotFound('Server')
      if (!SetAfkKickInput.shape.minutes.safeParse(minutes).success)
        throw new AppError('invalid_choice', 'An AFK kick is between 5 and 120 minutes, or never.')
      if ((await lockStanding(tx, server.ownerId)) === null) throw new NotFound('Account')
      const standing = await loadStanding(tx, server.ownerId)
      if (minutes !== null && !entitlementsOf(standing).mayChooseAfkKick)
        throw new AppError('not_entitled', 'Your plan keeps Cubepals’ own AFK kick. Plus lets you set it.')
      if (server.afkKickMinutes === minutes) return
      const version = server.version + 1
      await tx
        .update(schema.minecraftServers)
        .set({ afkKickMinutes: minutes, version, updatedAt: new Date() })
        .where(eq(schema.minecraftServers.id, server.id))
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'server.afk_kick_set',
        subjectType: 'server',
        subjectId: server.id,
        data: { minutes },
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

/** A previous web release may still show the account control: it must never change every server. */
export function accountAfkKickMoved(): never {
  throw new AppError(
    'invalid_choice',
    'Idle-kick choices now live in each server’s Settings. Reload this page to continue.',
  )
}
