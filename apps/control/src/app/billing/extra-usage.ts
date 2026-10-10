// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Extra play, counted and sent to the billing provider to be billed on the next payment
 * (docs/money-guards.md). Blockly is the only judge of hours: it counts what an account played past
 * its included block while it was allowed to (`domain/account/extra-play.ts`), never more than the
 * owner allowed, into a ledger per calendar month, and the provider only bills what it is sent.
 *
 * What is sent goes through an outbox: each event is written, under the id the provider keeps it
 * by, before it is sent, and sent again until the provider takes it. A lost reply or a crash sends
 * an event again under the same id, which the provider counts once, so nothing is dropped or billed
 * twice. Hours are counted in thousandths, rounded down, and sent in whole cents' worth, so any
 * rounding is the player's.
 *
 * It is not where servers stop at the end of what was allowed: `AccountService.enforceLimits` is.
 */
import { type Db, schema } from '@blockly/db'
import { and, asc, count, desc, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { type Entitlements, entitlementsFor } from '../../domain/account/entitlements.ts'
import { extraBeforeStop, extraPlay } from '../../domain/account/extra-play.ts'
import { UNIT_CENTS } from '../../domain/account/meter.ts'
import type { AccountStanding } from '../../domain/account/standing.ts'
import { loadStanding, notTest, runUnitsSince } from '../accounts/persistence.ts'
import {
  type BillingOrder,
  type BillingProvider,
  BillingUnavailable,
  type UsageEvent,
} from '../ports/optional.ts'
import { billingFacts, extraStoppedAt, latestSubscription } from './persistence.ts'

const months = schema.extraPlayMonths
const reports = schema.extraPlayReports

/** An event goes once this much is waiting, in thousandths of an hour: a quarter of an hour. */
const EVENT_MILLI = 250
/**
 * Every event is a whole number of cents' worth, in thousandths of an hour: 40 (0.04 h) at 25¢ an
 * hour. Polar multiplies what it is sent by the price and rounds to a cent; a sum of whole cents
 * never rounds, so its rounding never goes against the player.
 */
const CENT_MILLI = 1000 / gcd(1000, UNIT_CENTS)
/** Or once anything has waited this long, so a run that ends is billed soon after. */
const EVENT_WAIT_MS = 10 * 60_000
/**
 * How far behind the clock an event is dated. The provider refuses an event from the future, and
 * one it refuses holds back the rest of its batch, so a clock a little ahead of its own never does.
 */
const EVENT_BEHIND_MS = 60_000
/** Events in one request, and requests in one pass: well inside the provider's rate limit. */
const BATCH = 25
const BATCHES_PER_PASS = 4
/**
 * Refusals an event gets before it is no longer sent. With `backoff`, the last comes about eight
 * and a half hours after the first: long enough for a fix on the provider's side, not forever.
 */
const MAX_REFUSALS = 10
/** How long an event the provider refused waits: a minute, doubling, up to six hours. */
const backoff = (attempts: number) => Math.min(60_000 * 2 ** (attempts - 1), 6 * 3_600_000)

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500)

type ReportRow = typeof reports.$inferSelect

/**
 * How long a month must have been over before its count is final: past `usage-close`, which closes
 * an interval left open within ten minutes.
 */
const FINAL_AFTER_MS = 60 * 60_000

const monthOf = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
const nextMonth = (month: Date) => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))
const day = (at: Date) => at.toISOString().slice(0, 10)

export class ExtraUsage {
  readonly #db: Db
  readonly #billing: BillingProvider | null

  constructor(deps: { db: Db; billing: BillingProvider | null }) {
    this.#db = deps.db
    this.#billing = deps.billing
  }

  /** `extra-play-report`: count, cut events from what was counted, and send what waits. */
  async report(now = new Date()): Promise<void> {
    const accounts = new Set([...(await this.#playing(now)), ...(await this.#unfinished(now))])
    for (const userId of accounts) await this.count(userId, now)
    await this.cut(now)
    const { sent, failed } = await this.send(now)
    if (failed > 0) console.warn(`extra-play: ${failed} events not taken yet, ${sent} sent`)
  }

  /**
   * The account's extra play this month, and in any month before it that isn't final yet: what it
   * played past its included hours, held to what it could use, up to now or to the moment extra
   * play stopped (`#allowance`). It only grows, so a limit lowered after hours were played never
   * takes them back, and hours played while it couldn't use extra (servers sleep then) are never
   * counted. A month before this one is final (`finalAt`) once it has been over `FINAL_AFTER_MS`
   * and nothing that ran in it still runs; it is counted for the last time then. True when
   * something new was counted.
   */
  async count(userId: string, now = new Date()): Promise<boolean> {
    const standing = await loadStanding(this.#db, userId, now)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    if (plan.includedUnits === null) return false
    const allowance = await this.#allowance(standing, plan, now)
    let grew = false
    for (const month of await this.#months(userId, now, allowance !== null)) {
      const end = new Date(Math.min(nextMonth(month).getTime(), now.getTime()))
      const to = allowance === null ? month : new Date(Math.min(end.getTime(), allowance.until.getTime()))
      if (allowance !== null && to > month) {
        const units = await runUnitsSince(this.#db, userId, month, to)
        // Rounded down, but not by a binary fraction's last digit: 60.05 hours is 50 thousandths past 60.
        const milli = Math.floor(Math.min(units - plan.includedUnits, allowance.units) * 1000 + 1e-6)
        if (milli > 0) grew = (await this.#raise(userId, month, milli, now)) || grew
      }
      if (month < monthOf(now)) await this.#finalize(userId, month, now)
    }
    return grew
  }

  /**
   * What the account may count, and up to when: while it may play extra, what it allowed, up to
   * now; once it stopped (a cancel, a failed renewal, an ending), what it could use before, up to
   * that moment (`extraStoppedAt`). Null when it never could.
   */
  async #allowance(
    standing: AccountStanding,
    plan: Entitlements,
    now: Date,
  ): Promise<{ units: number; until: Date } | null> {
    const facts = await billingFacts(this.#db, standing.userId)
    const decision = extraPlay(plan, standing.extraUnitsAllowed, facts)
    if (decision.may) return { units: decision.units, until: now }
    const stopped = await extraStoppedAt(this.#db, standing.userId)
    const before = extraBeforeStop(plan, standing.extraUnitsAllowed, facts)
    return stopped !== null && before.may ? { units: before.units, until: stopped } : null
  }

  /** The months to count: this one, and those before it not final yet, the last one included. */
  async #months(userId: string, now: Date, mayCount: boolean): Promise<Date[]> {
    const current = monthOf(now)
    const previous = monthOf(new Date(current.getTime() - 1))
    const rows = await this.#db
      .select({ month: months.month, finalAt: months.finalAt })
      .from(months)
      .where(and(eq(months.userId, userId), lt(months.month, day(current))))
    const open = rows.filter((row) => row.finalAt === null).map((row) => new Date(`${row.month}T00:00:00Z`))
    if (mayCount && !rows.some((row) => row.month === day(previous))) open.push(previous)
    return [current, ...open]
  }

  /** Raises the month's count to `milli`, never lowers it. True when it grew. */
  async #raise(userId: string, month: Date, milli: number, now: Date): Promise<boolean> {
    const rows = await this.#db
      .insert(months)
      .values({ userId, month: day(month), accruedMilli: milli, pendingSince: now })
      .onConflictDoUpdate({
        target: [months.userId, months.month],
        set: {
          accruedMilli: milli,
          pendingSince: sql`coalesce(${months.pendingSince}, ${now})`,
          updatedAt: now,
        },
        setWhere: sql`${months.accruedMilli} < ${milli}`,
      })
      .returning({ userId: months.userId })
    return rows.length > 0
  }

  /**
   * A month before this one is final once it has been over `FINAL_AFTER_MS` (an interval closes
   * late, `usage-close`) and no server of the account that ran in it still runs.
   */
  async #finalize(userId: string, month: Date, now: Date): Promise<void> {
    const end = nextMonth(month)
    if (now.getTime() < end.getTime() + FINAL_AFTER_MS) return
    const intervals = schema.powerIntervals
    const [running] = await this.#db
      .select({ n: count() })
      .from(intervals)
      .innerJoin(schema.minecraftServers, eq(schema.minecraftServers.id, intervals.serverId))
      .where(
        and(
          eq(schema.minecraftServers.ownerId, userId),
          isNull(intervals.stoppedAt),
          lt(intervals.startedAt, end),
        ),
      )
    if ((running?.n ?? 0) > 0) return
    await this.#db
      .insert(months)
      .values({ userId, month: day(month), finalAt: now })
      .onConflictDoUpdate({ target: [months.userId, months.month], set: { finalAt: now, updatedAt: now } })
  }

  /**
   * Events from what was counted and not yet sent, in whole cents' worth (`CENT_MILLI`): once a
   * quarter of an hour waits, once anything has waited ten minutes, and what is left of a month
   * that is over. Each is written with
   * the next id of its account's month, and what it carries counts as reported from then on.
   */
  async cut(now = new Date()): Promise<number> {
    const due = await this.#db
      .select({ userId: months.userId, month: months.month })
      .from(months)
      .where(
        and(
          sql`${months.accruedMilli} - ${months.reportedMilli} >= ${CENT_MILLI}`,
          or(
            sql`${months.accruedMilli} - ${months.reportedMilli} >= ${EVENT_MILLI}`,
            lte(months.pendingSince, new Date(now.getTime() - EVENT_WAIT_MS)),
            sql`${months.month} < ${day(monthOf(now))}`,
          ),
        ),
      )
    for (const row of due)
      await this.#db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(months)
          .where(and(eq(months.userId, row.userId), eq(months.month, row.month)))
          .for('update')
        if (locked === undefined) return
        // Whole cents' worth only: the rest waits for more play, and what is left when a month is
        // over (under a cent) is never billed.
        const milli = Math.floor((locked.accruedMilli - locked.reportedMilli) / CENT_MILLI) * CENT_MILLI
        if (milli <= 0) return
        const [made] = await tx
          .select({ n: count() })
          .from(reports)
          .where(and(eq(reports.userId, row.userId), eq(reports.month, row.month)))
        await tx.insert(reports).values({
          externalId: `extra:${row.userId}:${row.month.slice(0, 7)}:${(made?.n ?? 0) + 1}`,
          userId: row.userId,
          month: row.month,
          milli,
          at: new Date(now.getTime() - EVENT_BEHIND_MS),
        })
        const reported = locked.reportedMilli + milli
        await tx
          .update(months)
          .set({
            reportedMilli: reported,
            pendingSince: reported < locked.accruedMilli ? now : null,
            updatedAt: now,
          })
          .where(and(eq(months.userId, row.userId), eq(months.month, row.month)))
      })
    return due.length
  }

  /**
   * Events not yet taken, oldest first, in batches. A batch the provider refuses is tried one
   * event at a time, so one it won't take never holds back the rest: each it refuses waits longer
   * before it is tried again (`backoff`), and after `MAX_REFUSALS` it is no longer sent, kept on
   * the account's audit log, and an admin is told (`extra_play_unsent`). Newer events go on in
   * the meantime. The provider being down refuses nothing: the pass stops, and all of it is tried
   * next minute, under the same ids.
   */
  async send(now = new Date()): Promise<{ sent: number; failed: number }> {
    const billing = this.#billing
    if (billing === null) return { sent: 0, failed: 0 }
    let sent = 0
    let failed = 0
    for (let pass = 0; pass < BATCHES_PER_PASS; pass++) {
      const batch = await this.#db
        .select()
        .from(reports)
        .where(
          and(
            isNull(reports.sentAt),
            isNull(reports.failedAt),
            or(isNull(reports.nextAttemptAt), lte(reports.nextAttemptAt, now)),
            // A test account's play is never sent to be billed; it waits, unsent.
            notTest(this.#db, reports.userId),
          ),
        )
        .orderBy(asc(reports.at), asc(reports.externalId))
        .limit(BATCH)
      if (batch.length === 0) break
      const { taken, down } = await this.#deliver(billing, batch, now)
      for (const event of taken)
        await this.#db
          .update(reports)
          .set({ sentAt: new Date() })
          .where(eq(reports.externalId, event.externalId))
      await this.#unbilled(batch, taken)
      sent += taken.length
      failed += batch.length - taken.length
      if (down) break
    }
    return { sent, failed }
  }

  /**
   * Events the provider took after the account's subscription ended: its last invoice was made
   * when it ended, and nothing bills them now. Kept on the account's audit log, with the last
   * order of that subscription, for an admin; nothing else is done.
   */
  async #unbilled(batch: readonly ReportRow[], taken: readonly UsageEvent[]): Promise<void> {
    const went = new Set(taken.map((event) => event.externalId))
    const rows = batch.filter((row) => went.has(row.externalId))
    for (const userId of new Set(rows.map((row) => row.userId))) {
      const latest = await latestSubscription(this.#db, userId)
      if (latest?.status !== 'ended') continue
      const orders = schema.billingOrders
      const [last] = await this.#db
        .select({ id: orders.externalOrderId })
        .from(orders)
        .where(eq(orders.externalSubscriptionId, latest.externalSubscriptionId))
        .orderBy(desc(orders.orderedAt))
        .limit(1)
      for (const row of rows.filter((r) => r.userId === userId))
        await this.#db.insert(schema.auditLog).values({
          actor: 'system:billing',
          action: 'billing.extra_unbilled',
          subjectType: 'account',
          subjectId: userId,
          data: {
            event: row.externalId,
            milli: row.milli,
            cents: Math.floor((row.milli * UNIT_CENTS) / 1000),
            subscription: latest.externalSubscriptionId,
            lastOrder: last?.id ?? null,
          },
        })
    }
  }

  /** One batch to the provider, then one event at a time if it refuses the batch. */
  async #deliver(
    billing: BillingProvider,
    batch: ReportRow[],
    now: Date,
  ): Promise<{ taken: UsageEvent[]; down: boolean }> {
    const events = batch.map((row) => ({
      externalId: row.externalId,
      userId: row.userId,
      hours: row.milli / 1000,
      at: row.at,
    }))
    const whole = await billing.reportUsage(events).then(
      () => null,
      (error: unknown) => error,
    )
    if (whole === null) return { taken: events, down: false }
    if (whole instanceof BillingUnavailable) {
      await this.#noted(batch, whole)
      return { taken: [], down: true }
    }
    const taken: UsageEvent[] = []
    for (const [i, row] of batch.entries()) {
      const event = events[i] as UsageEvent
      const alone = await billing.reportUsage([event]).then(
        () => null,
        (error: unknown) => error,
      )
      if (alone === null) taken.push(event)
      else if (alone instanceof BillingUnavailable) {
        await this.#noted(batch.slice(i), alone)
        return { taken, down: true }
      } else await this.#refused(row, alone, now)
    }
    return { taken, down: false }
  }

  /** The provider was down: what it said is kept, and nothing counts against the events. */
  async #noted(rows: readonly ReportRow[], error: unknown): Promise<void> {
    for (const row of rows)
      await this.#db
        .update(reports)
        .set({ lastError: messageOf(error) })
        .where(eq(reports.externalId, row.externalId))
  }

  /** The provider refused the event: tried again after a wait, or, refused enough, no longer. */
  async #refused(row: ReportRow, error: unknown, now: Date): Promise<void> {
    const attempts = row.attempts + 1
    const gaveUp = attempts >= MAX_REFUSALS
    await this.#db
      .update(reports)
      .set({
        attempts,
        lastError: messageOf(error),
        nextAttemptAt: gaveUp ? null : new Date(now.getTime() + backoff(attempts)),
        failedAt: gaveUp ? now : null,
      })
      .where(eq(reports.externalId, row.externalId))
    if (!gaveUp) return
    console.error(`extra-play: ${row.externalId} refused ${attempts} times, no longer sent`)
    await this.#db.insert(schema.auditLog).values({
      actor: 'system:billing',
      action: 'billing.extra_unsent',
      subjectType: 'account',
      subjectId: row.userId,
      data: {
        event: row.externalId,
        milli: row.milli,
        cents: Math.floor((row.milli * UNIT_CENTS) / 1000),
        attempts,
        error: messageOf(error),
      },
    })
  }

  /**
   * Accounts with a month before this one that isn't final, and those that may play extra whose
   * servers ran last month, its count not made final yet: each is counted until it is, whether or
   * not it plays now.
   */
  async #unfinished(now: Date): Promise<string[]> {
    const current = monthOf(now)
    const previous = monthOf(new Date(current.getTime() - 1))
    const open = await this.#db
      .selectDistinct({ userId: months.userId })
      .from(months)
      .where(and(lt(months.month, day(current)), isNull(months.finalAt)))
    const intervals = schema.powerIntervals
    const ranLastMonth = await this.#db
      .selectDistinct({ userId: schema.minecraftServers.ownerId })
      .from(intervals)
      .innerJoin(schema.minecraftServers, eq(schema.minecraftServers.id, intervals.serverId))
      .innerJoin(schema.accountStanding, eq(schema.accountStanding.userId, schema.minecraftServers.ownerId))
      .where(
        and(
          gt(schema.accountStanding.extraUnitsAllowed, 0),
          lt(intervals.startedAt, current),
          or(isNull(intervals.stoppedAt), gt(intervals.stoppedAt, previous)),
          sql`not exists (select 1 from ${months} where ${months.userId} = ${schema.minecraftServers.ownerId} and ${months.month} = ${day(previous)})`,
        ),
      )
    return [...open, ...ranLastMonth].map((row) => row.userId)
  }

  /** Accounts with a server that ran in the last quarter of an hour, or runs now. */
  async #playing(now: Date): Promise<string[]> {
    const intervals = schema.powerIntervals
    const rows = await this.#db
      .selectDistinct({ ownerId: schema.minecraftServers.ownerId })
      .from(intervals)
      .innerJoin(schema.minecraftServers, eq(schema.minecraftServers.id, intervals.serverId))
      .where(or(isNull(intervals.stoppedAt), gt(intervals.stoppedAt, new Date(now.getTime() - 15 * 60_000))))
    return rows.map((row) => row.ownerId)
  }
}

/** What an account's extra play this month comes to: counted, and of that, sent to be billed. */
export async function extraThisMonth(
  db: Db,
  userId: string,
  now = new Date(),
): Promise<{ countedUnits: number; reportedUnits: number }> {
  const [row] = await db
    .select()
    .from(months)
    .where(and(eq(months.userId, userId), eq(months.month, day(monthOf(now)))))
  return { countedUnits: (row?.accruedMilli ?? 0) / 1000, reportedUnits: (row?.reportedMilli ?? 0) / 1000 }
}

/**
 * A paid renewal, checked against what was sent for it: the extra play its metered line billed,
 * and the extra play Blockly sent between the subscription's order before and this one. The two
 * can differ honestly (the provider bills an event on the payment after it has processed it, which
 * can be a later one), so a difference is kept on the account's audit log, once per order, for an
 * admin to read, never acted on.
 */
export async function auditRenewal(db: Db, provider: string, order: BillingOrder): Promise<void> {
  if (order.billingReason !== 'subscription_cycle' || order.status !== 'paid' || order.userId === null) return
  const log = schema.auditLog
  const [told] = await db
    .select({ id: log.id })
    .from(log)
    .where(and(eq(log.action, 'billing.extra_billed'), sql`${log.data}->>'order' = ${order.externalOrderId}`))
  if (told !== undefined) return
  const orders = schema.billingOrders
  const [before] = await db
    .select({ at: orders.orderedAt })
    .from(orders)
    .where(
      and(
        eq(orders.provider, provider),
        eq(orders.userId, order.userId),
        order.externalSubscriptionId === null
          ? sql`true`
          : eq(orders.externalSubscriptionId, order.externalSubscriptionId),
        lt(orders.orderedAt, order.orderedAt),
      ),
    )
    .orderBy(desc(orders.orderedAt))
    .limit(1)
  const [sent] = await db
    .select({ milli: sql<string>`coalesce(sum(${reports.milli}), 0)` })
    .from(reports)
    .where(
      and(
        eq(reports.userId, order.userId),
        gte(reports.sentAt, before?.at ?? new Date(0)),
        lt(reports.sentAt, order.orderedAt),
      ),
    )
  const reportedCents = Math.round((Number(sent?.milli ?? 0) / 1000) * UNIT_CENTS)
  await db.insert(log).values({
    actor: 'system:billing',
    action: 'billing.extra_billed',
    subjectType: 'account',
    subjectId: order.userId,
    data: {
      order: order.externalOrderId,
      billedCents: order.extraCents,
      reportedCents,
      matches: Math.abs(reportedCents - order.extraCents) <= 1,
    },
  })
}

/** Events the provider refused until they were no longer sent (`MAX_REFUSALS`): hours not billed. */
export async function unsentExtra(db: Db): Promise<{ events: number; milli: number }> {
  const [row] = await db
    .select({ events: count(), milli: sql<string>`coalesce(sum(${reports.milli}), 0)` })
    .from(reports)
    .where(isNotNull(reports.failedAt))
  return { events: row?.events ?? 0, milli: Number(row?.milli ?? 0) }
}
