// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The purchases a person can cancel within 14 days of buying them, and what cancelling one gives
 * back now. A purchase is an order the account paid: a plan's first month (a renewal isn't one), a
 * year paid at once (renewing a year is a new one), a gift, or a chip-in. What it gives back is the
 * Refunds page's rule (`domain/account/withdrawal.ts`) over the hours played, counted as the
 * account page counts them (`meteredUnitsSince`): since the first month began, since the year or
 * the redeemed gift started, on the account that redeemed it; for a chip-in, its hours nobody
 * played, the newest chip-ins to a server taken as the last to be played. A first month carries the
 * subscription's other charges of its 14 days (a change of plan or price paid at once): cancelling
 * it ends the subscription whole, so they come back with it, counted in what was paid.
 *
 * It decides and stops nothing (`withdrawals.ts`), and reads purchases only of the account asking,
 * or of one order for its confirmation (`purchase-confirmation.ts`).
 */
import { FULL_REFUND_UNDER_HOURS } from '@blockly/contracts'
import { type Queryable, schema } from '@blockly/db'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm'
import { heldMilli } from '../../domain/account/chip-in.ts'
import { entitlementsFor, planName } from '../../domain/account/entitlements.ts'
import { type WithdrawalRule, type Withdrawn, withdrawalAmount } from '../../domain/account/withdrawal.ts'
import { meteredUnitsSince, pendingDraws } from './chip-in-meter.ts'
import { WITHDRAWAL_MS } from './ending.ts'
import { PAID_ORDER } from './persistence.ts'
import { stoppedAsSecond } from './second-subscriptions.ts'

const orders = schema.billingOrders
const subs = schema.billingSubscriptions
const years = schema.planYears
const gifts = schema.planGifts
const chipIns = schema.chipIns
const servers = schema.minecraftServers
const withdrawals = schema.billingWithdrawals

/** What an order bought, of the purchases that can be cancelled. */
type PurchaseKind = 'plan' | 'year' | 'gift' | 'chip_in'

/**
 * Polar's `billing_reason` for an order that starts a subscription, and for one that charges a
 * change to it at once (`proration_behavior: invoice`), as its API documents an order.
 */
const STARTS_SUBSCRIPTION = 'subscription_create'
const CHANGES_SUBSCRIPTION = 'subscription_update'

/** Another paid order of the subscription a first month began: a change of plan or price since. */
interface AlsoPaid {
  externalOrderId: string
  paidCents: number
  /** The plan its product sells; null when none. */
  planKey: string | null
  orderedAt: Date
}

/** One paid order, with what it bought. `kind` is null for an order that isn't a purchase (a renewal). */
export interface Purchase {
  provider: string
  externalOrderId: string
  /** The account that paid; null only for a gift a guest bought. */
  userId: string | null
  kind: PurchaseKind | null
  orderedAt: Date
  /** The last moment it can be cancelled from the account page. */
  until: Date
  /**
   * What the order charged, tax included, and what was refunded of it, as the provider says,
   * counted against `netCents`, what it earned before tax, as the provider counts a refund.
   */
  paidCents: number
  refundedCents: number
  netCents: number
  currency: string
  planKey: string | null
  externalSubscriptionId: string | null
  /** The plan its subscription sells now, and the hours it was sold with where its product set them. */
  subscription: { planKey: string; includedUnits: number | null } | null
  /**
   * A first month's other charges, each paid within its 14 days and not refunded; none for any
   * other purchase. They are what `paidInAll` adds.
   */
  also: AlsoPaid[]
  /** When its buyer was emailed its confirmation; null while that is still to send. */
  confirmedAt: Date | null
  year: typeof years.$inferSelect | null
  gift: typeof gifts.$inferSelect | null
  chipIn: (typeof chipIns.$inferSelect & { ownerId: string; serverName: string }) | null
}

/**
 * One of the account's purchases read for a change to it, inside a transaction: its order's row is
 * locked first, so a refund the provider delivers meanwhile is either in what is read or waits for
 * the transaction to end. Undefined when the account has no such paid order.
 */
export async function purchaseHeld(
  tx: Queryable,
  provider: string,
  userId: string,
  order: string,
): Promise<Purchase | undefined> {
  const [held] = await tx
    .select({ sub: orders.externalSubscriptionId })
    .from(orders)
    .where(and(eq(orders.provider, provider), eq(orders.externalOrderId, order)))
    .for('update')
  // Its subscription's other orders too: a refund of one of them is as much a change to it.
  if (held?.sub != null)
    await tx
      .select({ order: orders.externalOrderId })
      .from(orders)
      .where(and(eq(orders.provider, provider), eq(orders.externalSubscriptionId, held.sub)))
      .orderBy(asc(orders.externalOrderId))
      .for('update')
  const [purchase] = await purchasesOf(tx, provider, { userId, order })
  return purchase
}

/** What was paid for a purchase in all: its order, and a first month's other charges. */
const paidInAll = (purchase: Pick<Purchase, 'paidCents' | 'also'>): number =>
  purchase.also.reduce((sum, other) => sum + other.paidCents, purchase.paidCents)

/**
 * The account's paid orders, or one of them (`order`), newest first, with what each bought: only
 * those ordered after `since`, when given. Another account's order is never among them. With
 * `unconfirmed`, only purchases whose buyer hasn't been emailed a confirmation and that nothing
 * was refunded of, for the billing pass to send.
 */
export async function purchasesOf(
  q: Queryable,
  provider: string,
  filter: { userId?: string; order?: string; since?: Date; unconfirmed?: boolean },
): Promise<Purchase[]> {
  const rows = await q
    .select({
      order: orders,
      year: years,
      gift: gifts,
      chipIn: chipIns,
      ownerId: servers.ownerId,
      serverName: servers.name,
      subPlan: subs.planKey,
      subUnits: subs.includedUnits,
    })
    .from(orders)
    .leftJoin(
      subs,
      and(eq(subs.provider, orders.provider), eq(subs.externalSubscriptionId, orders.externalSubscriptionId)),
    )
    .leftJoin(
      years,
      and(eq(years.provider, orders.provider), eq(years.externalOrderId, orders.externalOrderId)),
    )
    .leftJoin(
      gifts,
      and(eq(gifts.provider, orders.provider), eq(gifts.externalOrderId, orders.externalOrderId)),
    )
    .leftJoin(
      chipIns,
      and(eq(chipIns.provider, orders.provider), eq(chipIns.externalOrderId, orders.externalOrderId)),
    )
    .leftJoin(servers, eq(servers.id, chipIns.serverId))
    .where(
      and(
        eq(orders.provider, provider),
        inArray(orders.status, PAID_ORDER),
        ...(filter.userId === undefined ? [] : [eq(orders.userId, filter.userId)]),
        ...(filter.order === undefined ? [] : [eq(orders.externalOrderId, filter.order)]),
        ...(filter.since === undefined ? [] : [gt(orders.orderedAt, filter.since)]),
        ...(filter.unconfirmed
          ? [
              isNull(orders.confirmedAt),
              eq(orders.refundedCents, 0),
              or(
                eq(orders.billingReason, STARTS_SUBSCRIPTION),
                isNotNull(years.externalOrderId),
                isNotNull(gifts.id),
                isNotNull(chipIns.externalOrderId),
              ),
            ]
          : []),
      ),
    )
    .orderBy(desc(orders.orderedAt))
  const others = await alsoPaid(
    q,
    provider,
    rows.flatMap(({ order }) =>
      order.billingReason === STARTS_SUBSCRIPTION && order.externalSubscriptionId !== null
        ? [order.externalSubscriptionId]
        : [],
    ),
  )
  return rows.map(({ order, year, gift, chipIn, ownerId, serverName, subPlan, subUnits }) => {
    const kind = kindOf(order, { year, gift, chipIn })
    const until = new Date(order.orderedAt.getTime() + WITHDRAWAL_MS)
    return {
      provider: order.provider,
      externalOrderId: order.externalOrderId,
      userId: order.userId,
      kind,
      orderedAt: order.orderedAt,
      until,
      paidCents: order.totalCents,
      refundedCents: order.refundedCents,
      netCents: order.netCents,
      currency: order.currency,
      planKey: order.planKey,
      externalSubscriptionId: order.externalSubscriptionId,
      subscription: subPlan === null ? null : { planKey: subPlan, includedUnits: subUnits },
      also:
        kind === 'plan'
          ? (others.get(order.externalSubscriptionId ?? '') ?? []).filter(
              (other) => other.orderedAt >= order.orderedAt && other.orderedAt <= until,
            )
          : [],
      confirmedAt: order.confirmedAt,
      year,
      gift,
      chipIn: chipIn && ownerId !== null && serverName !== null ? { ...chipIn, ownerId, serverName } : null,
    }
  })
}

/**
 * The paid, unrefunded orders that charged a change to each of the subscriptions at once, oldest
 * first, by subscription. A renewal isn't one, and what was refunded already has come back.
 */
async function alsoPaid(
  q: Queryable,
  provider: string,
  subscriptions: string[],
): Promise<Map<string, AlsoPaid[]>> {
  const bySub = new Map<string, AlsoPaid[]>()
  if (subscriptions.length === 0) return bySub
  const rows = await q
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.provider, provider),
        inArray(orders.externalSubscriptionId, subscriptions),
        eq(orders.billingReason, CHANGES_SUBSCRIPTION),
        inArray(orders.status, PAID_ORDER),
        gt(orders.totalCents, 0),
        eq(orders.refundedCents, 0),
      ),
    )
    .orderBy(asc(orders.orderedAt), asc(orders.externalOrderId))
  for (const row of rows) {
    const sub = row.externalSubscriptionId ?? ''
    bySub.set(sub, [
      ...(bySub.get(sub) ?? []),
      {
        externalOrderId: row.externalOrderId,
        paidCents: row.totalCents,
        planKey: row.planKey,
        orderedAt: row.orderedAt,
      },
    ])
  }
  return bySub
}

/**
 * What an order bought: a year, a gift or a chip-in it made, or a plan's first month; null for
 * anything else, a renewal among them.
 */
function kindOf(
  order: typeof orders.$inferSelect,
  made: { year: unknown; gift: unknown; chipIn: unknown },
): PurchaseKind | null {
  if (made.year) return 'year'
  if (made.gift) return 'gift'
  if (made.chipIn) return 'chip_in'
  const first = order.billingReason === STARTS_SUBSCRIPTION
  return first && order.externalSubscriptionId && order.planKey ? 'plan' : null
}

/**
 * What one of a first month's other charges is called: "the upgrade to Plus" where it moved the
 * subscription to another plan, "a change to its price" where the plan stayed.
 */
export function alsoTitle(first: Pick<Purchase, 'planKey'>, other: { planKey: string | null }): string {
  return other.planKey !== null && other.planKey !== first.planKey
    ? `the upgrade to ${planName(other.planKey)}`
    : 'a change to its price'
}

/**
 * What a purchase is called on the account page and in its emails: "your first month of Plus", "a
 * year of Plus", "a gift of a month of Plus", "your chip-in to Maple Hollow".
 */
export function purchaseTitle(purchase: Purchase): string {
  const plan = planName(purchase.year?.planKey ?? purchase.gift?.planKey ?? purchase.planKey ?? 'plus')
  if (purchase.kind === 'year') return `a year of ${plan}`
  if (purchase.kind === 'gift') {
    const months = purchase.gift?.months ?? 1
    return `a gift of ${months === 1 ? 'a month' : `${months} months`} of ${plan}`
  }
  if (purchase.kind === 'chip_in') return `your chip-in to ${purchase.chipIn?.serverName ?? 'a server'}`
  return `your first month of ${plan}`
}

/** What cancelling a purchase now gives back, and what it was worked out from. */
export interface Assessed {
  /** What was paid in all (`paidInAll`), which the refund is a part of. */
  paidCents: number
  playedMilli: number
  includedUnits: number | null
  earlierFull: boolean
  refundCents: number
  rule: WithdrawalRule
}

/**
 * What the rule gives for the purchase if it is cancelled at `now`, from the hours played by then.
 * Run in the transaction that keeps the request, under the locks of the accounts whose play counts,
 * so the amount kept is the one the play then gives.
 */
export async function assess(q: Queryable, purchase: Purchase, now: Date): Promise<Assessed> {
  const buyer = purchase.userId
  const earlierFull = buyer === null ? false : await hadFullRefund(q, purchase.provider, buyer, purchase)
  const paidCents = paidInAll(purchase)
  const of = (withdrawn: Withdrawn, playedMilli: number, includedUnits: number | null) => ({
    paidCents,
    playedMilli,
    includedUnits,
    earlierFull,
    ...withdrawalAmount(withdrawn),
  })
  if (purchase.kind === 'chip_in' && purchase.chipIn !== null) {
    const unplayed = await unplayedMilli(q, purchase.chipIn, now)
    const playedMilli = Math.max(0, heldMilli(purchase.chipIn) - unplayed)
    return of({ kind: 'chip_in', paidCents, milli: purchase.chipIn.milli, playedMilli }, playedMilli, null)
  }
  const time = timeOf(purchase, now)
  if (time === null) return of({ kind: 'unredeemed', paidCents }, 0, null)
  const playedUnits = time.started ? await meteredUnitsSince(q, time.userId, time.since, now) : 0
  const withdrawn: Withdrawn = {
    kind: 'time',
    paidCents,
    months: time.months,
    started: time.started,
    playedUnits,
    includedUnits: time.includedUnits,
    earlierFull,
    fullUnderHours: FULL_REFUND_UNDER_HOURS,
  }
  return of(withdrawn, Math.round(playedUnits * 1000), time.includedUnits)
}

/**
 * Whether the account had everything back on another purchase of time on a plan, which a person
 * has once: one cancelled here under the line (`rule: full`), or one the provider refunded in full,
 * as a refund through support arrives, its refund reaching what the order earned before tax (as
 * `monthsKept` counts it). A purchase cancelled here counts by the rule its request kept, whatever
 * is paid for it after: time that hadn't started comes back whole and isn't the once. A purchase
 * refunded in part doesn't count, nor does a gift nobody redeemed or a chip-in, which come back
 * whole or by their unplayed share whatever came before, nor a second subscription's charge given
 * back (`stoppedAsSecond`), which no withdrawal is.
 */
async function hadFullRefund(
  q: Queryable,
  provider: string,
  userId: string,
  purchase: Pick<Purchase, 'externalOrderId'>,
): Promise<boolean> {
  const asked = await q
    .select({ order: withdrawals.externalOrderId, rule: withdrawals.rule })
    .from(withdrawals)
    .where(and(eq(withdrawals.userId, userId), ne(withdrawals.externalOrderId, purchase.externalOrderId)))
  if (asked.some((request) => request.rule === 'full')) return true
  const others = (await purchasesOf(q, provider, { userId })).filter(
    (other) =>
      other.externalOrderId !== purchase.externalOrderId &&
      // Cancelled here: its request's rule, read above, says whether it was the once.
      !asked.some((request) => request.order === other.externalOrderId) &&
      timeOnPlan(other) &&
      other.netCents > 0 &&
      other.refundedCents >= other.netCents,
  )
  for (const other of others) {
    // A second subscription's charge given back is a correction, not a refund the person had.
    const sub = other.kind === 'plan' ? other.externalSubscriptionId : null
    if (sub === null || !(await stoppedAsSecond(q, userId, sub))) return true
  }
  return false
}

/** A purchase of time on a plan: a first month, a year, or a gift somebody redeemed. */
const timeOnPlan = (purchase: Purchase): boolean =>
  purchase.kind === 'plan' ||
  purchase.kind === 'year' ||
  (purchase.kind === 'gift' && purchase.gift?.redeemedBy != null)

/**
 * The time on a plan a purchase gave, whose play counts: whose account, from when, over how many
 * months, and the hours a month its plan includes. Null for a gift nobody has redeemed.
 */
function timeOf(purchase: Purchase, now: Date) {
  if (purchase.kind === 'year' && purchase.year !== null) {
    const { userId, startsAt, planKey } = purchase.year
    return { userId, since: startsAt, started: startsAt <= now, months: 12, includedUnits: hoursOf(planKey) }
  }
  if (purchase.kind === 'gift') {
    const gift = purchase.gift
    if (gift?.redeemedBy == null || gift.startsAt === null || gift.planKey === null) return null
    const started = gift.startsAt <= now
    return {
      userId: gift.redeemedBy,
      since: gift.startsAt,
      started,
      months: gift.months ?? 1,
      includedUnits: hoursOf(gift.planKey),
    }
  }
  const userId = purchase.userId ?? ''
  return {
    userId,
    since: purchase.orderedAt,
    started: true,
    months: 1,
    includedUnits: subscriptionHours(purchase),
  }
}

/** The hours a month a plan includes, as the plan table has them. */
const hoursOf = (planKey: string): number | null => entitlementsFor(planKey).includedUnits

/**
 * The hours a month a first month's subscription gives: its own where its product set them (an
 * early price), otherwise those of the plan it sells now, which an upgrade since may have changed.
 */
export function subscriptionHours(purchase: Pick<Purchase, 'subscription' | 'planKey'>): number | null {
  if (purchase.subscription?.includedUnits != null) return purchase.subscription.includedUnits
  const planKey = purchase.subscription?.planKey ?? purchase.planKey
  return planKey === null ? null : hoursOf(planKey)
}

/**
 * A chip-in's hours nobody has played yet, in thousandths: what its server has left, taken as the
 * newest chip-ins' first, so what was paid first is what was played first. Read under the owner's
 * draw lock (`ChipIns.draw`), so no draw moves it meanwhile.
 */
async function unplayedMilli(
  q: Queryable,
  chipIn: NonNullable<Purchase['chipIn']>,
  now: Date,
): Promise<number> {
  const pending = await pendingDraws(q, chipIn.ownerId, now)
  let left = Math.floor((pending?.left.get(chipIn.serverId) ?? 0) * 1000)
  const newestFirst = await q
    .select()
    .from(chipIns)
    .where(and(eq(chipIns.serverId, chipIn.serverId), lte(chipIns.receivedAt, now)))
    .orderBy(desc(chipIns.receivedAt), desc(chipIns.externalOrderId))
  for (const row of newestFirst) {
    const unplayed = Math.min(heldMilli(row), left)
    if (row.provider === chipIn.provider && row.externalOrderId === chipIn.externalOrderId) return unplayed
    left -= unplayed
  }
  return 0
}
