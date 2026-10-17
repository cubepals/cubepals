// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A plan paid for a year at once (`plan_years`): the provider sells it as a one-time order, so the
 * year is Blockly's to keep. It starts when it is paid, or when the time the account has already
 * paid for ends (another year, a redeemed gift, or a month of a subscription), so nothing paid for
 * is lost. A refund brings its end back to the whole months still paid for. The owner hears 14 and
 * 3 days before the last year ends, since nothing renews it, and its end by the clock is audited
 * once.
 *
 * Whether a year gives the account its plan now is `billedPlan`'s (`persistence.ts`). Hours still
 * start again each month, with what is left carried once (`accounts/play-month.ts`), as they do
 * for the plan by the month.
 */
import { DAY_MS } from '@blockly/contracts/durations'
import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, asc, desc, eq, gt, inArray, isNull, lte, max } from 'drizzle-orm'
import { loadStanding } from '../accounts/persistence.ts'
import type { BillingOrder } from '../ports/optional.ts'
import { type AuditEntry, type BillingSource, planChange, planRecordedSince, writeEntries } from './audit.ts'
import { PAID_ORDER, PAYING } from './persistence.ts'

const years = schema.planYears
const orders = schema.billingOrders
const gifts = schema.planGifts
const subscriptions = schema.billingSubscriptions

/** The months a year holds, and so how a refund is counted back from its end. */
const YEAR_MONTHS = 12

/** Days before the last year paid for ends that its owner is told, the earliest first. */
export const YEAR_REMINDER_DAYS = [14, 3] as const

/** `months` calendar months after `at`, in UTC, on the same day or the month's last. */
export function addMonths(at: Date, months: number): Date {
  const day = at.getUTCDate()
  const moved = new Date(at)
  moved.setUTCDate(1)
  moved.setUTCMonth(moved.getUTCMonth() + months)
  const last = new Date(Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0)).getUTCDate()
  moved.setUTCDate(Math.min(day, last))
  return moved
}

/**
 * The whole months of a year an order still pays for after what was refunded of it: a twelfth of
 * what it earned (before tax) for each, rounded down, so a refund of the months left ends the year
 * after the month it is in, and a full one (or one past a month's share) ends it where it began.
 * A year a code made free is kept whole.
 */
export function monthsKept(order: Pick<BillingOrder, 'netCents' | 'refundedCents'>): number {
  if (order.netCents <= 0) return order.refundedCents > 0 ? 0 : YEAR_MONTHS
  const left = Math.max(0, order.netCents - order.refundedCents)
  return Math.floor((YEAR_MONTHS * left) / order.netCents)
}

/**
 * A year's order, kept as the provider says it now: the year it pays for is made the first time
 * it is paid, starting when the time the account already has ends, and shortened by what has been
 * refunded since. The refund is the order's as `recordOrder` kept it, which only grows, so a paid
 * delivery that comes again after a refund never gives the year back: its end only ever moves
 * earlier. Answers what changed, for the audit log; null for an order that pays for no year or
 * hasn't been paid. Run under the account's standing lock, so two years can't both start at the
 * same end.
 */
export async function recordYear(
  tx: Tx,
  provider: string,
  order: BillingOrder,
): Promise<AuditEntry[] | null> {
  if (!order.paysForYear || order.userId === null || order.planKey === null) return null
  if (!PAID_ORDER.includes(order.status)) return null
  const about = { provider, order: order.externalOrderId, plan: order.planKey }
  const [kept] = await tx
    .select({ refundedCents: orders.refundedCents })
    .from(orders)
    .where(and(eq(orders.provider, provider), eq(orders.externalOrderId, order.externalOrderId)))
  const paid = {
    netCents: order.netCents,
    refundedCents: Math.max(order.refundedCents, kept?.refundedCents ?? 0),
  }
  const [held] = await tx
    .select()
    .from(years)
    .where(and(eq(years.provider, provider), eq(years.externalOrderId, order.externalOrderId)))
  if (held !== undefined) {
    const endsAt = addMonths(held.startsAt, monthsKept(paid))
    if (endsAt.getTime() >= held.endsAt.getTime()) return []
    await tx
      .update(years)
      .set({ endsAt, updatedAt: new Date() })
      .where(and(eq(years.provider, provider), eq(years.externalOrderId, order.externalOrderId)))
    return [
      {
        action: 'billing.year_shortened',
        data: { ...about, endsAt: endsAt.toISOString(), was: held.endsAt.toISOString() },
      },
    ]
  }
  const startsAt = await paidUntil(tx, order.userId, order.orderedAt)
  const endsAt = addMonths(startsAt, monthsKept(paid))
  await tx.insert(years).values({
    provider,
    externalOrderId: order.externalOrderId,
    userId: order.userId,
    planKey: order.planKey,
    startsAt,
    endsAt,
  })
  return [
    {
      action: 'billing.year_bought',
      data: { ...about, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
    },
  ]
}

/**
 * When the time the account has paid for ends, from `at` on: the last of its years, the last of
 * the gifts it redeemed (`gifts.ts`), or the end of the period a subscription has paid, whichever
 * is later; `at` when none runs past it.
 */
async function paidUntil(q: Queryable, userId: string, at: Date): Promise<Date> {
  const year = await lastYearEnd(q, userId)
  const [gift] = await q
    .select({ endsAt: max(gifts.endsAt) })
    .from(gifts)
    .where(and(eq(gifts.redeemedBy, userId), isNull(gifts.voidedAt)))
  const [month] = await q
    .select({ endsAt: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, PAYING),
        gt(subscriptions.currentPeriodEnd, at),
      ),
    )
    .orderBy(desc(subscriptions.currentPeriodEnd))
    .limit(1)
  const ends = [at, year, gift?.endsAt ? new Date(gift.endsAt) : null, month?.endsAt ?? null]
  return new Date(Math.max(...ends.filter((end): end is Date => end !== null).map((end) => end.getTime())))
}

/** When the last of the account's years ends, so a gift redeemed now starts after it; null with none. */
export async function lastYearEnd(q: Queryable, userId: string): Promise<Date | null> {
  const [year] = await q
    .select({ endsAt: years.endsAt })
    .from(years)
    .where(eq(years.userId, userId))
    .orderBy(desc(years.endsAt))
    .limit(1)
  return year?.endsAt ?? null
}

/**
 * The account's years still to run, the soonest first: the one running now, then any paid ahead.
 * One refunded in full before it started has no time in it, and isn't one.
 */
export async function yearsAhead(q: Queryable, userId: string, now: Date) {
  return q
    .select()
    .from(years)
    .where(and(eq(years.userId, userId), gt(years.endsAt, now), gt(years.endsAt, years.startsAt)))
    .orderBy(asc(years.startsAt))
}

/**
 * For the account page: the plan a year pays for, when the first year still to run starts, when
 * the last ends, and whether another is paid for after the first. Null with none to run.
 */
export async function yearView(
  q: Queryable,
  userId: string,
  now: Date,
): Promise<{ planKey: string; startsAt: Date; endsAt: Date; renewed: boolean } | null> {
  const ahead = await yearsAhead(q, userId, now)
  const first = ahead[0]
  const last = ahead.at(-1)
  if (first === undefined || last === undefined) return null
  return { planKey: first.planKey, startsAt: first.startsAt, endsAt: last.endsAt, renewed: ahead.length > 1 }
}

/** A year whose owner is due to be told it is ending, and how many days ahead they are told. */
export interface YearEnding {
  userId: string
  provider: string
  externalOrderId: string
  planKey: string
  endsAt: Date
  days: number
}

/**
 * Years ending within the reminders' reach that are the last their account has paid for (no
 * later year, and no gift redeemed to run on after it), held whole (a refund that shortened one was the owner's choice to stop), on an account no
 * subscription renews, with a reminder due that hasn't been sent: the latest reminder it has
 * reached, so one sent late never sends the earlier one too.
 */
export async function yearsToRemind(q: Queryable, now: Date): Promise<YearEnding[]> {
  const reach = new Date(now.getTime() + Math.max(...YEAR_REMINDER_DAYS) * DAY_MS)
  const rows = await q
    .select()
    .from(years)
    .where(and(gt(years.endsAt, now), lte(years.endsAt, reach)))
  const due: YearEnding[] = []
  for (const row of rows) {
    if (row.endsAt.getTime() !== addMonths(row.startsAt, YEAR_MONTHS).getTime()) continue
    const left = (row.endsAt.getTime() - now.getTime()) / DAY_MS
    const days = YEAR_REMINDER_DAYS.filter((reminder) => left <= reminder).at(-1)
    if (days === undefined || (row.remindedDays !== null && row.remindedDays <= days)) continue
    const [later] = await q
      .select({ endsAt: years.endsAt })
      .from(years)
      .where(and(eq(years.userId, row.userId), gt(years.endsAt, row.endsAt)))
      .limit(1)
    if (later !== undefined) continue
    const [gifted] = await q
      .select({ endsAt: gifts.endsAt })
      .from(gifts)
      .where(and(eq(gifts.redeemedBy, row.userId), isNull(gifts.voidedAt), gt(gifts.endsAt, row.endsAt)))
      .limit(1)
    if (gifted !== undefined) continue
    const [renewing] = await q
      .select({ id: subscriptions.externalSubscriptionId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, row.userId),
          inArray(subscriptions.status, PAYING),
          eq(subscriptions.cancelAtPeriodEnd, false),
        ),
      )
      .limit(1)
    if (renewing !== undefined) continue
    due.push({
      userId: row.userId,
      provider: row.provider,
      externalOrderId: row.externalOrderId,
      planKey: row.planKey,
      endsAt: row.endsAt,
      days,
    })
  }
  return due
}

/** The owner was told the year ends in `days`. */
export async function markReminded(q: Queryable, year: YearEnding): Promise<void> {
  await q
    .update(years)
    .set({ remindedDays: year.days, updatedAt: new Date() })
    .where(and(eq(years.provider, year.provider), eq(years.externalOrderId, year.externalOrderId)))
}

/** Accounts with a year that has ended by `now` whose end isn't in the audit log yet. */
export async function accountsWithYearsEnded(q: Queryable, now: Date): Promise<string[]> {
  const rows = await q
    .selectDistinct({ userId: years.userId })
    .from(years)
    .where(and(lte(years.endsAt, now), isNull(years.endRecordedAt)))
  return rows.map((row) => row.userId)
}

/**
 * Each of the account's years that has ended by `now`, recorded once as `billing.year_ended`, with
 * the plan change it made unless a word since (a refund) recorded it. Run under the account's
 * standing lock. Answers how many were recorded.
 */
export async function recordYearEnds(
  tx: Tx,
  userId: string,
  actor: string,
  source: BillingSource,
  now: Date,
): Promise<number> {
  const ended = await tx
    .select()
    .from(years)
    .where(and(eq(years.userId, userId), lte(years.endsAt, now), isNull(years.endRecordedAt)))
  for (const year of ended) {
    const before = (await loadStanding(tx, userId, new Date(year.endsAt.getTime() - 1))).plan
    const after = (await loadStanding(tx, userId, now)).plan
    const told = before !== after && (await planRecordedSince(tx, userId, year.endsAt)) === after
    const endsAt = year.endsAt.toISOString()
    await writeEntries(tx, userId, actor, source, [
      {
        action: 'billing.year_ended',
        data: { provider: year.provider, order: year.externalOrderId, plan: year.planKey, endsAt },
      },
      ...(told ? [] : planChange(before, after, { lapsedAt: endsAt })),
    ])
    await tx
      .update(years)
      .set({ endRecordedAt: now, updatedAt: now })
      .where(and(eq(years.provider, year.provider), eq(years.externalOrderId, year.externalOrderId)))
  }
  return ended.length
}
