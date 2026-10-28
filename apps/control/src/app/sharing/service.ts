// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type JoinThroughInviteResult, shownName } from '@blockly/contracts'
import { HOUR_MS } from '@blockly/contracts/durations'
import { type Db, schema } from '@blockly/db'
import { and, eq, gte, max, sql } from 'drizzle-orm'
import { namedBy } from '../access/identity.ts'
import { readAccess } from '../access/persistence.ts'
import type { AccessService } from '../access/service.ts'
import type { Actor, UserActor } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { FUNNEL, noteOnce } from '../insight/record.ts'
import { inviteOpen } from '../listings/reachable.ts'
import type { Limits } from '../ports/limits.ts'
import { findByInvite, findServer } from '../servers/persistence.ts'
import { loadRevisionFields } from '../servers/revision-reads.ts'
import { tuning } from '../tuning.ts'
import { perAddress } from './queries.ts'

/** Whoever holds the link acts for themselves, not for the owner. */
const INVITEE: Actor = { kind: 'system', reason: 'invite' }

/**
 * Joining through an invite (§15.6). The link is the permission: its holder may put their own
 * Minecraft name on the whitelist, with no Blockly account, because the owner sent it to them.
 * The funnel's word of the link on its way, its owner sharing it and someone opening it, is kept
 * here too.
 */
export class SharingService {
  readonly #db: Db
  readonly #access: AccessService
  readonly #limits: Limits

  constructor(deps: { db: Db; access: AccessService; limits: Limits }) {
    this.#db = deps.db
    this.#access = deps.access
    this.#limits = deps.limits
  }

  /** The owner copied their server's invite link: kept once for the server. Anyone else's isn't found. */
  async inviteShared(actor: UserActor, serverId: string): Promise<void> {
    const server = await findServer(this.#db, serverId)
    if (server === null || server.ownerId !== actor.userId) throw new NotFound('Server')
    await noteOnce(this.#db, {
      event: FUNNEL.inviteShared,
      subject: server.id,
      userId: server.ownerId,
      properties: { serverId: server.id },
    })
  }

  /**
   * Someone opened the invitation: kept once for the server, never for its owner opening their
   * own. The page asks for this from the browser once it shows the invitation, so a link preview,
   * which fetches the page and its picture without running either, never counts. It answers
   * nothing, whether the code is real or not, and is counted for the client's address `from`, per
   * code and across every code, at the invitation's own limits (`publicReadsPerMinute`); past
   * them, nothing is kept.
   */
  async inviteOpened(code: string, viewer: UserActor | null, from: string | null = null): Promise<void> {
    const limits = tuning().abuse.publicReadsPerMinute
    if (!(await this.#limits.allow(perAddress(`opened:${code}`, from), limits.invite))) return
    if (!(await this.#limits.allow(perAddress('opened', from), limits.invites))) return
    const server = await findByInvite(this.#db, code)
    if (server === null || server.ownerId === viewer?.userId) return
    await noteOnce(this.#db, {
      event: FUNNEL.inviteOpened,
      subject: server.id,
      userId: server.ownerId,
      properties: { serverId: server.id },
    })
  }

  async joinThroughInvite(code: string, playerName: string): Promise<JoinThroughInviteResult> {
    const server = await findByInvite(this.#db, code)
    if (server === null || !(await inviteOpen(this.#db, server))) throw new NotFound('Invite')

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
    const { onlineMode } = (await loadRevisionFields(this.#db, server.desiredRevisionId, ['settings']))
      .settings
    const listed = access.record.entries.find(
      (entry) =>
        entry.list === 'whitelist' &&
        (entry.state === 'active' || entry.state === 'pending_add') &&
        namedBy(entry.player, typed, onlineMode),
    )
    if (listed !== undefined) return { playerName: shownName(listed.player), added: false, asleep }

    // Joins through this link only (`AbuseLimits.inviteJoinsPerHour`): the ones since its owner last
    // replaced it, within the hour. Resetting a link ends the old one along with its count, so the
    // new link has a whole hour's worth of its own.
    const [reset] = await this.#db
      .select({ at: max(schema.auditLog.at) })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.subjectType, 'server'),
          eq(schema.auditLog.subjectId, server.id),
          eq(schema.auditLog.action, 'server.invite_reset'),
        ),
      )
    const hourAgo = new Date(Date.now() - HOUR_MS)
    const since = reset?.at && reset.at > hourAgo ? reset.at : hourAgo
    const [used] = await this.#db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.subjectType, 'server'),
          eq(schema.auditLog.subjectId, server.id),
          eq(schema.auditLog.action, 'access.invite_join'),
          gte(schema.auditLog.at, since),
        ),
      )
    if ((used?.n ?? 0) >= tuning().abuse.inviteJoinsPerHour)
      throw new AppError(
        'rate_limited',
        'This invite has let in a lot of people in the last hour. Ask its owner to add you.',
      )

    // The name is resolved against Minecraft itself, so a typo is caught here rather than at the
    // door, and the whitelist holds the account rather than a spelling.
    await this.#access.add(INVITEE, server.id, 'whitelist', typed)
    const saved = (await readAccess(this.#db, server.id)).record.entries.find(
      (entry) => entry.list === 'whitelist' && namedBy(entry.player, typed, true),
    )
    await this.#db.insert(schema.auditLog).values({
      actor: 'system:invite',
      action: 'access.invite_join',
      subjectType: 'server',
      subjectId: server.id,
      data: { playerName: saved ? shownName(saved.player) : typed },
    })
    return { playerName: saved ? shownName(saved.player) : typed, added: true, asleep }
  }
}
