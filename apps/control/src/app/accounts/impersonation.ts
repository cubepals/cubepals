// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An admin using a test account ("Use as this account"): signed in as it for an hour, to play and
 * test Cubepals the way that account would, on its plan, until they switch back. Only a test
 * account, never an admin, and both ends go in the audit log with the admin as the actor and the
 * test account as the subject.
 *
 * This decides who may and keeps the record. The sessions themselves are the sign-in provider's
 * (`SessionSwitch`). Refusing admin pages to such a session is the API's (interfaces/trpc/trpc.ts).
 */
import { type Db, schema } from '@blockly/db'
import { type Actor, requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import type { SessionSwitch } from '../ports/auth.ts'
import { isAdmin, lockStanding } from './persistence.ts'

export class Impersonation {
  readonly #db: Db

  constructor(deps: { db: Db }) {
    this.#db = deps.db
  }

  /**
   * The admin's session becomes the test account's. The audit row and the switch commit together:
   * a switch that fails leaves no row, and a test account unmarked meanwhile can't be used.
   */
  async start(actor: Actor, userId: string, session: SessionSwitch): Promise<void> {
    if (actor.kind !== 'admin') throw new NotFound('Account')
    await this.#db.transaction(async (tx) => {
      const standing = await lockStanding(tx, userId)
      if (standing === null) throw new NotFound('Account')
      if (!standing.testAccount || (await isAdmin(tx, userId)))
        throw new AppError('invalid_choice', 'Only a test account can be used this way, and never an admin.')
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'account.use_as_started',
        subjectType: 'account',
        subjectId: userId,
        data: {},
      })
      await session.impersonate(userId)
    })
  }

  /** Back to the admin's own session, from the test account's (`impersonatedBy` is the admin). */
  async end(actor: Actor, impersonatedBy: string | null, session: SessionSwitch): Promise<void> {
    if (actor.kind !== 'user' || impersonatedBy === null)
      throw new AppError('invalid_transition', 'You’re signed in as yourself already.')
    await this.#db.transaction(async (tx) => {
      await tx.insert(schema.auditLog).values({
        actor: requestedBy({ kind: 'admin', userId: impersonatedBy }),
        action: 'account.use_as_ended',
        subjectType: 'account',
        subjectId: actor.userId,
        data: {},
      })
      await session.stopImpersonating()
    })
  }
}
