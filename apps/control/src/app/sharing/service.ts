// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { JoinThroughInviteResult } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { and, eq, gte, max, sql } from 'drizzle-orm'
import { readAccess } from '../access/persistence.ts'
import type { AccessService } from '../access/service.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { Actor } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { loadListing } from '../listings/persistence.ts'
import { findByInvite, loadRevision } from '../servers/persistence.ts'

/** Whoever holds the link acts for themselves, not for the owner. */
const INVITEE: Actor = { kind: 'system', reason: 'invite' }

/**
 * How many people one invite link may let in per hour. A link is meant for friends; a leaked one
 * should cost its holder little and its owner nothing, and resetting it ends the old one along
 * with its count, so the new link has a whole hour's worth of its own.
 */
const JOINS_PER_HOUR = 10

/**
 * Joining through an invite (§15.6). The link is the permission: its holder may put their own
 * Minecraft name on the whitelist, with no Blockly account, because the owner sent it to them.
 */
export class SharingService {
  readonly #db: Db
  readonly #access: AccessService

  constructor(deps: { db: Db; access: AccessService }) {
    this.#db = deps.db
    this.#access = deps.access
  }

  async joinThroughInvite(code: string, playerName: string): Promise<JoinThroughInviteResult> {
    const server = await findByInvite(this.#db, code)
    if (server === null) throw new NotFound('Invite')
    const listing = await loadListing(this.#db, server.id)
    if (listing?.moderation === 'removed') throw new NotFound('Invite')
    if ((await loadStanding(this.#db, server.ownerId)).status !== 'active') throw new NotFound('Invite')

    const access = await readAccess(this.#db, server.id)
    const whitelisted = access.record.whitelistEnabledPending ?? access.record.whitelistEnabled
    const asleep = server.lifecycle.status !== 'running'
    const typed = playerName.trim()
    // Nothing to do: anyone with the address can already join, so the name is not Blockly's to keep.
    if (!whitelisted) return { playerName: typed, added: false, asleep }

    // A friend already on the list who joins again, from a reload or a new session, is told so,
    // and it isn't counted: the link's hour is for letting people in, and they are in. A server
    // that checks accounts knows a name whatever its capitals, as Minecraft does; one that doesn't
    // treats each spelling as a player of its own.
    const { onlineMode } = (await loadRevision(this.#db, server.desiredRevisionId)).settings
    const listed = access.record.entries.find(
      (entry) =>
        entry.list === 'whitelist' &&
        (entry.state === 'active' || entry.state === 'pending_add') &&
        (onlineMode ? entry.player.name.toLowerCase() === typed.toLowerCase() : entry.player.name === typed),
    )
    if (listed !== undefined) return { playerName: listed.player.name, added: false, asleep }

    // Joins through this link only: the ones since its owner last replaced it, within the hour.
    const [reset] = await this.#db
      .select({ at: max(schema.auditLog.at) })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, server.id), eq(schema.auditLog.action, 'server.invite_reset')))
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const since = reset?.at && reset.at > hourAgo ? reset.at : hourAgo
    const [used] = await this.#db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.subjectId, server.id),
          eq(schema.auditLog.action, 'access.invite_join'),
          gte(schema.auditLog.at, since),
        ),
      )
    if ((used?.n ?? 0) >= JOINS_PER_HOUR)
      throw new AppError(
        'rate_limited',
        'This invite has let in a lot of people in the last hour. Ask its owner to add you.',
      )

    // The name is resolved against Minecraft itself, so a typo is caught here rather than at the
    // door, and the whitelist holds the account rather than a spelling.
    await this.#access.add(INVITEE, server.id, 'whitelist', typed)
    const saved = (await readAccess(this.#db, server.id)).record.entries.find(
      (entry) => entry.list === 'whitelist' && entry.player.name.toLowerCase() === typed.toLowerCase(),
    )
    await this.#db.insert(schema.auditLog).values({
      actor: 'system:invite',
      action: 'access.invite_join',
      subjectType: 'server',
      subjectId: server.id,
      data: { playerName: saved?.player.name ?? typed },
    })
    return { playerName: saved?.player.name ?? typed, added: true, asleep }
  }
}
