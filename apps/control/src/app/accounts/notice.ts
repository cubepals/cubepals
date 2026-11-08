// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operator's notice on an account (`domain/account/notice.ts`), kept with its standing: read,
 * set and cleared through the operators' API, each in the audit log, and its limit put on the
 * account once, when its time comes (`account-notices`, every minute), claimed together with its
 * limit in one transaction, so a notice cleared or replaced meanwhile is left alone. That limit is
 * the one an operator sets by hand: the account's own running limit at 0, as `ops.ts limits
 * <account> --running 0` sets it, and its running servers stopped the way any lowered limit stops
 * them, their worlds saved. Clearing a notice leaves a limit it put in place: lifting it is `limits`.
 *
 * Not for showing it: the server list's is `app/edge/`'s, the chat's
 * `operations/schedules/notice-said.ts`'s. Both read it here.
 */
import { type Db, type Queryable, schema } from '@blockly/db'
import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm'
import type { AccountNotice } from '../../domain/account/notice.ts'
import { messageProblem } from '../../domain/revision/revision.ts'
import { type Actor, requestedBy, runsThePlatform } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { lockStanding } from './persistence.ts'
import type { AccountService } from './service.ts'

const standing = schema.accountStanding

const COLUMNS = {
  text: standing.notice,
  setAt: standing.noticeSetAt,
  setBy: standing.noticeSetBy,
  limitAt: standing.noticeLimitAt,
  limitedAt: standing.noticeLimitedAt,
}

/** A row's notice; null where it has none. */
function noticeFrom(row: {
  text: string | null
  setAt: Date | null
  setBy: string | null
  limitAt: Date | null
  limitedAt: Date | null
}): AccountNotice | null {
  const { text, setAt, setBy, limitAt, limitedAt } = row
  if (text === null || setAt === null || setBy === null) return null
  return { text, setAt, setBy, limitAt, limitedAt }
}

/** The account's notice; null where it has none. */
export async function noticeOf(q: Queryable, userId: string): Promise<AccountNotice | null> {
  const [row] = await q.select(COLUMNS).from(standing).where(eq(standing.userId, userId))
  return row === undefined ? null : noticeFrom(row)
}

/**
 * Of `ownerIds`, the ones with a notice, with its text and when it was set: which notice it is,
 * so one replaced since is never taken for it.
 */
export async function noticesOf(
  q: Queryable,
  ownerIds: readonly string[],
): Promise<Map<string, Pick<AccountNotice, 'text' | 'setAt'>>> {
  if (ownerIds.length === 0) return new Map()
  const rows = await q
    .select({ userId: standing.userId, text: standing.notice, setAt: standing.noticeSetAt })
    .from(standing)
    .where(and(inArray(standing.userId, [...ownerIds]), isNotNull(standing.notice)))
  return new Map(
    rows.flatMap(({ userId, text, setAt }) =>
      text === null || setAt === null ? [] : [[userId, { text, setAt }] as const],
    ),
  )
}

/**
 * Forgets when the account's servers last said its notice, so whoever is on hears the next one at
 * the next reading.
 */
async function forgetSaid(q: Queryable, userId: string): Promise<void> {
  const owned = q
    .select({ id: schema.minecraftServers.id })
    .from(schema.minecraftServers)
    .where(eq(schema.minecraftServers.ownerId, userId))
  await q.delete(schema.noticeSaid).where(inArray(schema.noticeSaid.serverId, owned))
}

/**
 * Who a notice's limit is put on the account as: whoever set the notice, as the audit log named
 * them, so the limit reads as theirs where the account's history shows it.
 */
function actorOf(setBy: string): Actor {
  const [kind, ...rest] = setBy.split(':')
  const who = rest.join(':')
  if (kind === 'operator' && who !== '') return { kind: 'operator', name: who }
  if (kind === 'admin' && who !== '') return { kind: 'admin', userId: who }
  throw new Error(`A notice was set by ${setBy}, who can't limit an account`)
}

export class AccountNotices {
  readonly #db: Db
  readonly #accounts: Pick<AccountService, 'setLimits' | 'stopServersOf'>

  constructor(deps: { db: Db; accounts: Pick<AccountService, 'setLimits' | 'stopServersOf'> }) {
    this.#db = deps.db
    this.#accounts = deps.accounts
  }

  async get(actor: Actor, userId: string): Promise<AccountNotice | null> {
    if (!runsThePlatform(actor)) throw new NotFound('Account')
    return noticeOf(this.#db, userId)
  }

  /**
   * Puts `text` on the account in place of any notice before, with the time it limits the account,
   * if any; a limit to come is put on again by a new notice that names one, even one done before.
   * Whoever is on its servers hears the new one at the next reading.
   */
  async set(
    actor: Actor,
    userId: string,
    notice: { text: string; limitAt: Date | null },
  ): Promise<AccountNotice> {
    if (!runsThePlatform(actor)) throw new NotFound('Account')
    const text = notice.text.trim()
    const problem = messageProblem(text)
    if (problem !== null) throw new AppError('invalid_choice', problem)
    const set: AccountNotice = {
      text,
      setAt: new Date(),
      setBy: requestedBy(actor),
      limitAt: notice.limitAt,
      limitedAt: null,
    }
    await this.#db.transaction(async (tx) => {
      if ((await lockStanding(tx, userId)) === null) throw new NotFound('Account')
      await tx
        .update(standing)
        .set({
          notice: set.text,
          noticeSetAt: set.setAt,
          noticeSetBy: set.setBy,
          noticeLimitAt: set.limitAt,
          noticeLimitedAt: null,
          updatedAt: set.setAt,
        })
        .where(eq(standing.userId, userId))
      await forgetSaid(tx, userId)
      await tx.insert(schema.auditLog).values({
        actor: set.setBy,
        action: 'account.notice_set',
        subjectType: 'account',
        subjectId: userId,
        data: { notice: set.text, limitAt: set.limitAt?.toISOString() ?? null },
      })
    })
    return set
  }

  /**
   * Takes the account's notice away: its servers show their own messages again, and a limit still
   * to come is never put on. A limit it already put on stays; the answer says so. Null where there
   * was no notice.
   */
  async clear(actor: Actor, userId: string): Promise<AccountNotice | null> {
    if (!runsThePlatform(actor)) throw new NotFound('Account')
    return this.#db.transaction(async (tx) => {
      if ((await lockStanding(tx, userId)) === null) throw new NotFound('Account')
      const was = await noticeOf(tx, userId)
      if (was === null) return null
      await tx
        .update(standing)
        .set({
          notice: null,
          noticeSetAt: null,
          noticeSetBy: null,
          noticeLimitAt: null,
          noticeLimitedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(standing.userId, userId))
      await forgetSaid(tx, userId)
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'account.notice_cleared',
        subjectType: 'account',
        subjectId: userId,
        data: { notice: was.text, limitedAt: was.limitedAt?.toISOString() ?? null },
      })
      return was
    })
  }

  /**
   * `account-notices`: each notice whose limit is due puts it on its account, once
   * (`limitIfStillDue`). One account that fails doesn't keep the rest from theirs; the pass fails
   * after, saying which. How many were limited.
   */
  async applyDue(now = new Date()): Promise<number> {
    const due = await this.#db
      .select({ userId: standing.userId, setAt: standing.noticeSetAt })
      .from(standing)
      .where(
        and(isNotNull(standing.notice), isNull(standing.noticeLimitedAt), lte(standing.noticeLimitAt, now)),
      )
    const failed: string[] = []
    let limited = 0
    for (const { userId, setAt } of due) {
      if (setAt === null) continue
      try {
        if (await this.limitIfStillDue(userId, setAt, now)) limited++
      } catch (error) {
        failed.push(`${userId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failed.length > 0) throw new Error(`Notices' limits not put on: ${failed.join('; ')}`)
    return limited
  }

  /**
   * Puts the limit of the notice set at `setAt` on the account, if that notice is still the
   * account's and still due. Under the standing's lock, one transaction claims it, so a notice
   * cleared or replaced since it was read is left alone, sets the running limit to 0 through the
   * account's limits (its other limits kept, as `ops.ts limits` sends them, audited as
   * `account.limits_set`), and records `account.notice_limited`: a claim never stands without its
   * limit. What runs is stopped after, as well as it can be; one still running past a crash or a
   * failed stop is stopped by `standing-sweep`, which stops what an account runs past its running
   * limit. Whether it was put on.
   */
  async limitIfStillDue(userId: string, setAt: Date, now = new Date()): Promise<boolean> {
    const limited = await this.#db.transaction(async (tx) => {
      const locked = await lockStanding(tx, userId)
      if (locked === null) return false
      const [claimed] = await tx
        .update(standing)
        .set({ noticeLimitedAt: now, updatedAt: now })
        .where(
          and(
            eq(standing.userId, userId),
            eq(standing.noticeSetAt, setAt),
            isNotNull(standing.notice),
            isNull(standing.noticeLimitedAt),
            lte(standing.noticeLimitAt, now),
          ),
        )
        .returning({ setBy: standing.noticeSetBy, limitAt: standing.noticeLimitAt })
      if (claimed === undefined) return false
      const setBy = claimed.setBy ?? ''
      const { limitOverrides } = locked
      await this.#accounts.setLimits(
        actorOf(setBy),
        userId,
        {
          maxServers: limitOverrides.maxServers ?? null,
          maxRunning: 0,
          includedUnits: limitOverrides.includedUnits ?? null,
        },
        tx,
      )
      await tx.insert(schema.auditLog).values({
        actor: setBy,
        action: 'account.notice_limited',
        subjectType: 'account',
        subjectId: userId,
        data: { limitAt: (claimed.limitAt ?? now).toISOString() },
      })
      return true
    })
    if (!limited) return false
    await this.#accounts
      .stopServersOf(userId, 'entitlement')
      .catch((error: unknown) =>
        console.warn('account notice limit', userId, error instanceof Error ? error.message : error),
      )
    return true
  }
}
