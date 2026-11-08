// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly does to keep free hours one person's: keeps a new account's inbox and sign-up
 * network and links it to the others of its inbox, links free accounts one main player plays most
 * on and new ones whose players moved from another that ran out of free hours, puts linked accounts into groups and acts by how sure it is of each
 * (`domain/account/free-links.ts`), and lets an admin hold or release them, or mark a pair handled.
 * Every account that comes to share another's hours, and every hold, release and handled pair, is on
 * the account's audit log. An
 * address never refuses anything. The facts and their queries are `free-play.ts`'s and
 * `free-links.ts`'s.
 */
import type { FreeLinkView } from '@blockly/contracts'
import { type Db, schema, type Tx } from '@blockly/db'
import { and, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm'
import { NO_SIGNALS } from '../../domain/account/free-links.ts'
import { addressKey } from '../../domain/account/free-play.ts'
import { type Actor, requestedBy, runsThePlatform } from '../actor.ts'
import { NotFound } from '../errors.ts'
import { tuning } from '../tuning.ts'
import {
  addCandidate,
  type Candidates,
  forgetNetworks,
  mainPlayerPairs,
  type NowShared,
  regroup,
  scorePairs,
} from './free-links.ts'
import { keepEmailKey, sharing, unkeyedAccounts } from './free-play.ts'
import { movedPlayerPairs } from './players-moved.ts'

const links = schema.freeLinks
const play = schema.freePlay

/** Accounts keyed at a time when filling in the ones made before inboxes were kept. */
const FILL_BATCH = 500

export class FreePlayGuard {
  readonly #db: Db

  constructor(deps: { db: Db }) {
    this.#db = deps.db
  }

  /**
   * A new account's inbox and the network it signed up from (`address`, when known), kept, and
   * the account linked to the others of the same inbox.
   */
  async signedUp(userId: string, emailKey: string, address: string | null = null): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const found: Candidates = new Map()
      for (const other of await keepEmailKey(tx, userId, emailKey, addressKey(address)))
        addCandidate(found, userId, other, { inbox: 1 })
      if (found.size === 0) return
      await scorePairs(tx, found)
      await sharedAudit(tx, await regroup(tx))
    })
  }

  /**
   * Accounts made before inboxes were kept, keyed by `keyOf` and linked the same way; run where
   * the api starts. Nothing to do once every account has one.
   */
  async fillEmailKeys(keyOf: (email: string) => string): Promise<number> {
    let filled = 0
    for (;;) {
      const batch = await unkeyedAccounts(this.#db, FILL_BATCH)
      if (batch.length === 0) return filled
      for (const { id, email } of batch) await this.signedUp(id, keyOf(email))
      filled += batch.length
    }
  }

  /**
   * `free-play-links`: free accounts one main player plays most on, and new ones whose players
   * moved from another that ran out of free hours, scored and linked, every group made again, and
   * networks past keeping forgotten. How many accounts came to share another's hours.
   */
  async relink(now = new Date()): Promise<number> {
    return this.#db.transaction(async (tx) => {
      await forgetNetworks(tx, now)
      const found = await mainPlayerPairs(tx, now)
      for (const { a, b, signals } of (await movedPlayerPairs(tx, now)).values())
        addCandidate(found, a, b, signals)
      await scorePairs(tx, found)
      const shared = await regroup(tx)
      await sharedAudit(tx, shared)
      return shared.length
    })
  }

  /** Every link not released in a group admins are shown (`medium` and up), newest first. */
  async links(actor: Actor): Promise<FreeLinkView[]> {
    if (actor.kind !== 'admin') throw new NotFound('Linked accounts')
    const rows = await this.#db
      .select({ link: links, confidence: play.confidence })
      .from(links)
      .innerJoin(play, eq(play.userId, links.accountId))
      .where(and(isNull(links.releasedAt), gte(play.confidence, tuning().freeLinks.medium)))
      .orderBy(desc(links.createdAt))
    const ids = [...new Set(rows.flatMap(({ link }) => [link.accountId, link.linkedId]))]
    if (ids.length === 0) return []
    const people = await this.#db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        heldAt: play.heldAt,
        groupId: play.groupId,
        confidence: play.confidence,
      })
      .from(schema.users)
      .leftJoin(play, eq(play.userId, schema.users.id))
      .where(inArray(schema.users.id, ids))
    const byId = new Map(people.map((p) => [p.id, p]))
    const person = (id: string) => ({
      userId: id,
      email: byId.get(id)?.email ?? '',
      held: (byId.get(id)?.heldAt ?? null) !== null,
    })
    return rows.map(({ link, confidence }) => ({
      account: person(link.accountId),
      linked: person(link.linkedId),
      score: link.score,
      signals: { ...NO_SIGNALS, ...link.signals },
      confidence: confidence ?? 0,
      shared: sharing(byId.get(link.accountId), byId.get(link.linkedId)),
      since: link.createdAt.toISOString(),
      reviewed: link.reviewedAt !== null,
    }))
  }

  /**
   * One pair dealt with: marked reviewed, so it is no longer new under Linked accounts or in the
   * alert inbox, and nothing else changes. No hold, no release, and whether the pair shares free
   * hours stays as it was. On the audit log of the later account.
   */
  async handled(actor: Actor, accountId: string, linkedId: string, now = new Date()): Promise<void> {
    if (!runsThePlatform(actor)) throw new NotFound('Linked accounts')
    await this.#db.transaction(async (tx) => {
      const marked = await tx
        .update(links)
        .set({ reviewedAt: now })
        .where(and(pairOf(accountId, linkedId), isNull(links.releasedAt)))
        .returning({ accountId: links.accountId, linkedId: links.linkedId })
      const [pair] = marked
      if (pair === undefined) throw new NotFound('Linked accounts')
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'account.free_link_handled',
        subjectType: 'account',
        subjectId: pair.accountId,
        data: { with: pair.linkedId },
      })
    })
  }

  /** No free server of this account starts or is made until it is released. Nothing is deleted. */
  async hold(actor: Actor, userId: string, now = new Date()): Promise<void> {
    if (actor.kind !== 'admin') throw new NotFound('Account')
    await this.#db.transaction(async (tx) => {
      // An account whose inbox isn't kept yet is held all the same; the next fill keeps it.
      await tx
        .insert(play)
        .values({ userId, emailKey: '', heldAt: now })
        .onConflictDoUpdate({ target: play.userId, set: { heldAt: now } })
      await tx.update(links).set({ reviewedAt: now }).where(involving(userId))
      await tx.insert(schema.auditLog).values({
        actor: `admin:${actor.userId}`,
        action: 'account.free_held',
        subjectType: 'account',
        subjectId: userId,
        data: {},
      })
    })
  }

  /**
   * The account's free play is its own again: no hold, and no link counting another account's
   * play as its own. A release holds: the same two accounts are never linked again on their own.
   */
  async release(actor: Actor, userId: string, now = new Date()): Promise<void> {
    if (actor.kind !== 'admin') throw new NotFound('Account')
    await this.#db.transaction(async (tx) => {
      await tx.update(play).set({ heldAt: null }).where(eq(play.userId, userId))
      const released = await tx
        .update(links)
        .set({ reviewedAt: now, releasedAt: now })
        .where(and(involving(userId), isNull(links.releasedAt)))
        .returning({ accountId: links.accountId, linkedId: links.linkedId })
      await sharedAudit(tx, await regroup(tx))
      await tx.insert(schema.auditLog).values({
        actor: `admin:${actor.userId}`,
        action: 'account.free_released',
        subjectType: 'account',
        subjectId: userId,
        data: { unlinked: released.map((r) => (r.accountId === userId ? r.linkedId : r.accountId)) },
      })
    })
  }
}

/** The link between two accounts, whichever of them signed up later. */
const pairOf = (x: string, y: string) =>
  or(and(eq(links.accountId, x), eq(links.linkedId, y)), and(eq(links.accountId, y), eq(links.linkedId, x)))

/** The links an account is on either side of. */
const involving = (userId: string) => or(eq(links.accountId, userId), eq(links.linkedId, userId))

/** Each account that now shares its group's first account's free hours, on its audit log. */
async function sharedAudit(tx: Tx, shared: readonly NowShared[]): Promise<void> {
  for (const { userId, firstId, confidence } of shared)
    await tx.insert(schema.auditLog).values({
      actor: 'system:free-play',
      action: 'account.free_linked',
      subjectType: 'account',
      subjectId: userId,
      data: { with: firstId, confidence: Math.round(confidence * 100) / 100 },
    })
}
