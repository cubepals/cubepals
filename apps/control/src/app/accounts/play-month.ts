// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * This month's play, on a plan with a monthly block (`Entitlements.includedUnits`): the spans it
 * is counted over, from the owner's local midnight on the 1st, in meter units, and what carried
 * into it from last month's block. The month the block began in counts from when it began, so
 * play on another plan earlier that month is never spent from it; its block is still whole. What
 * is left of a month's own block, up to the plan's `carryUnits`, carries into the next month, and
 * no further: carried hours are spent first, so a month that plays into them keeps its own for the
 * month after. A month the block did not cover from its 1st carries nothing. The clock is
 * `domain/account/play-day.ts`'s; stopping servers when the month is used is the session check's.
 *
 * It is not where play is read: `billing/chip-in-meter.ts` (`meteredMonth`) reads each month's
 * play over these spans with what friends chipped in taken out, which never counts against the
 * owner's hours nor carries.
 */
import { type Queryable, schema } from '@blockly/db'
import { and, eq, isNull, lte } from 'drizzle-orm'
import type { Entitlements } from '../../domain/account/entitlements.ts'
import { DEFAULT_TIME_ZONE, monthBegan, nextMonthStart } from '../../domain/account/play-day.ts'
import { type AccountStanding, zoneChange } from '../../domain/account/standing.ts'

/**
 * The months looked back over for what carried. Carried hours never carry again, so a month a
 * year back almost never changes this one's; the first month looked at starts with nothing carried.
 */
const MONTHS_BACK = 12

export interface PlayMonth {
  /** The owner's midnight on this month's 1st, and on the next month's: when the block is back. */
  start: Date
  next: Date
  /** The plan's monthly block, in units. */
  included: number
  /** What was left of last month's block, carried into this one, in units. */
  carried: number
  /** Played since the month began, open runs counted up to now (or to the month's end). */
  units: number
}

/**
 * What carries out of the last of `months`: each month's own block, less what it played past what
 * carried into it, and never more than `cap`. `months` is the play of each whole month the block
 * covered, oldest first.
 */
export function carriedOut(included: number, cap: number, months: readonly number[]): number {
  let carried = 0
  for (const units of months) carried = Math.min(cap, Math.max(0, included - Math.max(0, units - carried)))
  return carried
}

/** The spans a month's play is read over, and the block they are measured against. */
export interface MonthSpans {
  /**
   * When this month's count began: the owner's midnight on its 1st, or when the block began if
   * that was later. `next` is the owner's midnight on the next month's 1st: when the block is back.
   */
  start: Date
  next: Date
  /** The plan's monthly block, in units. */
  included: number
  /** The most of a month's own block that carries into the next, in units. */
  carry: number
  /** Each whole month before this one the block covered, oldest first, at most `MONTHS_BACK`. */
  before: Array<{ from: Date; to: Date }>
}

/**
 * The month `at` falls in, and the months before it that carry into it; null when the plan has no
 * monthly block. `at` is `now` unless a month already over is asked for, as billing asks for one
 * it hasn't closed.
 */
export async function monthSpans(
  q: Queryable,
  standing: Pick<AccountStanding, 'userId' | 'plan' | 'timeZone' | 'timeZoneFrom' | 'timeZoneBegan'>,
  plan: Pick<Entitlements, 'includedUnits' | 'carryUnits'>,
  now: Date,
  at: Date = now,
): Promise<MonthSpans | null> {
  if (plan.includedUnits === null) return null
  const zone = standing.timeZone ?? DEFAULT_TIME_ZONE
  const change = zoneChange(standing)
  const first = monthBegan(at, zone, change)
  // When the block began: when the run of paid time on the plan that holds `now` began, each
  // stretch of it (subscription, years paid at once in `billing/years.ts`, gifts redeemed in
  // `billing/gifts.ts`) running on from or over the one before, so months on Free never carry.
  const spans = await paidSpans(q, standing.userId, standing.plan, now)
  const began = spans.length > 0 ? runBegan(spans) : await accountMade(q, standing.userId)
  // The month paid time began in counts from then: what was played before was another plan's.
  const start = spans.length > 0 && began !== null && began > first ? began : first
  // Whole months before this one, oldest first, back to the first the block covered from its 1st.
  const before: Date[] = []
  let month = monthBegan(new Date(first.getTime() - 1), zone, change)
  while (began !== null && month >= began && before.length < MONTHS_BACK) {
    before.unshift(month)
    month = monthBegan(new Date(month.getTime() - 1), zone, change)
  }
  return {
    start,
    next: nextMonthStart(at, zone),
    included: plan.includedUnits,
    carry: plan.carryUnits ?? 0,
    before: before.map((from, i) => ({ from, to: before[i + 1] ?? first })),
  }
}

/**
 * The month's play from what each of its spans played: `units` holds one number for each month in
 * `before`, then this month's.
 */
export function playOf(month: MonthSpans, units: readonly number[]): PlayMonth {
  return {
    start: month.start,
    next: month.next,
    included: month.included,
    carried: carriedOut(month.included, month.carry, units.slice(0, -1)),
    units: units.at(-1) ?? 0,
  }
}

/** A stretch of the plan the account paid for or was given: a subscription's, a year's or a gift's. */
interface PaidSpan {
  from: Date
  to: Date
}

/** When the account was made: where the block of a plan nothing pays for (an admin's) began. */
async function accountMade(q: Queryable, userId: string): Promise<Date | null> {
  const [made] = await q
    .select({ at: schema.accountStanding.createdAt })
    .from(schema.accountStanding)
    .where(eq(schema.accountStanding.userId, userId))
  return made?.at ?? null
}

/**
 * When the newest of `spans` to begin began, moved back over each one that reaches it with no gap
 * between. A span that ends before the run begins is skipped: one that began earlier still may.
 */
function runBegan(spans: readonly PaidSpan[]): Date {
  const newest = [...spans].sort((a, b) => b.from.getTime() - a.from.getTime())
  let began = newest[0]?.from ?? new Date(0)
  for (const span of newest) if (span.to >= began && span.from < began) began = span.from
  return began
}

/** The account's paid stretches of the plan that have begun by `now`, refunded gifts left out. */
async function paidSpans(q: Queryable, userId: string, plan: string, now: Date): Promise<PaidSpan[]> {
  const subscriptions = schema.billingSubscriptions
  const years = schema.planYears
  const gifts = schema.planGifts
  const months = await q
    .select({ from: subscriptions.createdAt, to: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.planKey, plan)))
  const paidAtOnce = await q
    .select({ from: years.startsAt, to: years.endsAt })
    .from(years)
    .where(and(eq(years.userId, userId), eq(years.planKey, plan), lte(years.startsAt, now)))
  const given = await q
    .select({ from: gifts.startsAt, to: gifts.endsAt })
    .from(gifts)
    .where(
      and(
        eq(gifts.redeemedBy, userId),
        eq(gifts.planKey, plan),
        isNull(gifts.voidedAt),
        lte(gifts.startsAt, now),
      ),
    )
  const spans: PaidSpan[] = []
  // A subscription with no paid period yet still began the block when it was made.
  for (const month of months)
    if (month.from <= now) spans.push({ from: month.from, to: month.to ?? month.from })
  for (const span of [...paidAtOnce, ...given])
    if (span.from !== null && span.to !== null && span.to > span.from)
      spans.push({ from: span.from, to: span.to })
  return spans
}
