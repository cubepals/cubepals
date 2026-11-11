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
 * played, the newest chip-ins to a server taken as the last to be played.
 *
 * It decides and stops nothing (`withdrawals.ts`), and reads purchases only of the account asking,
 * or of one order for its confirmation (`purchase-confirmation.ts`).
 */
import { FULL_REFUND_UNDER_HOURS } from '@blockly/contracts'
import { type Queryable, schema } from '@blockly/db'
import { and, desc, eq, gt, inArray, lte, ne } from 'drizzle-orm'
import { heldMilli } from '../../domain/account/chip-in.ts'
import { entitlementsFor, planName } from '../../domain/account/entitlements.ts'
import { type WithdrawalRule, type Withdrawn, withdrawalAmount } from '../../domain/account/withdrawal.ts'
import { meteredUnitsSince, pendingDraws } from './chip-in-meter.ts'
import { WITHDRAWAL_MS } from './ending.ts'
import { PAID_ORDER } from './persistence.ts'

const orders = schema.billingOrders
const years = schema.planYears
const gifts = schema.planGifts
const chipIns = schema.chipIns
const servers = schema.minecraftServers
const withdrawals = schema.billingWithdrawals

/** What an order bought, of the purchases that can be cancelled. */
type PurchaseKind = 'plan' | 'year' | 'gift' | 'chip_in'

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
  year: typeof years.$inferSelect | null
  gift: typeof gifts.$inferSelect | null
  chipIn: (typeof chipIns.$inferSelect & { ownerId: string; serverName: string }) | null
}

/**
 * The account's paid orders, or one of them (`order`), newest first, with what each bought: only
 * those ordered after `since`, when given. Another account's order is never among them.
 */
export async function purchasesOf(
  q: Queryable,
  provider: string,
  filter: { userId?: string; order?: string; since?: Date },
): Promise<Purchase[]> {
  const rows = await q
    .select({
      order: orders,
      year: years,
      gift: gifts,
      chipIn: chipIns,
      ownerId: servers.ownerId,
      serverName: servers.name,
    })
    .from(orders)
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
      ),
    )
    .orderBy(desc(orders.orderedAt))
  return rows.map(({ order, year, gift, chipIn, ownerId, serverName }) => ({
    provider: order.provider,
    externalOrderId: order.externalOrderId,
    userId: order.userId,
    kind: kindOf(order, { year, gift, chipIn }),
    orderedAt: order.orderedAt,
    until: new Date(order.orderedAt.getTime() + WITHDRAWAL_MS),
    paidCents: order.totalCents,
    refundedCents: order.refundedCents,
    netCents: order.netCents,
    currency: order.currency,
    planKey: order.planKey,
    externalSubscriptionId: order.externalSubscriptionId,
    year,
    gift,
    chipIn: chipIn && ownerId !== null && serverName !== null ? { ...chipIn, ownerId, serverName } : null,
  }))
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
  const first = order.billingReason === 'subscription_create'
  return first && order.externalSubscriptionId && order.planKey ? 'plan' : null
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
  const paidCents = purchase.paidCents
  const of = (withdrawn: Withdrawn, playedMilli: number, includedUnits: number | null) => ({
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
  const time = await timeOf(q, purchase, now)
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
 * `monthsKept` counts it). A purchase refunded in part doesn't count, nor does a gift nobody
 * redeemed or a chip-in, which come back whole or by their unplayed share whatever came before.
 */
async function hadFullRefund(
  q: Queryable,
  provider: string,
  userId: string,
  purchase: Pick<Purchase, 'externalOrderId'>,
): Promise<boolean> {
  const [asked] = await q
    .select({ order: withdrawals.externalOrderId })
    .from(withdrawals)
    .where(
      and(
        eq(withdrawals.userId, userId),
        eq(withdrawals.rule, 'full'),
        ne(withdrawals.externalOrderId, purchase.externalOrderId),
      ),
    )
    .limit(1)
  if (asked !== undefined) return true
  const others = await purchasesOf(q, provider, { userId })
  return others.some(
    (other) =>
      other.externalOrderId !== purchase.externalOrderId &&
      timeOnPlan(other) &&
      other.netCents > 0 &&
      other.refundedCents >= other.netCents,
  )
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
async function timeOf(q: Queryable, purchase: Purchase, now: Date) {
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
    includedUnits: await subscriptionHours(q, purchase),
  }
}

/** The hours a month a plan includes, as the plan table has them. */
const hoursOf = (planKey: string): number | null => entitlementsFor(planKey).includedUnits

/**
 * The hours a month a first month's subscription was sold with: its own where its product set
 * them (an early price), the plan's otherwise.
 */
export async function subscriptionHours(
  q: Queryable,
  purchase: Pick<Purchase, 'provider' | 'externalSubscriptionId' | 'planKey'>,
): Promise<number | null> {
  if (purchase.externalSubscriptionId !== null) {
    const [sold] = await q
      .select({ units: schema.billingSubscriptions.includedUnits })
      .from(schema.billingSubscriptions)
      .where(
        and(
          eq(schema.billingSubscriptions.provider, purchase.provider),
          eq(schema.billingSubscriptions.externalSubscriptionId, purchase.externalSubscriptionId),
        ),
      )
    if (sold?.units != null) return sold.units
  }
  return purchase.planKey === null ? null : hoursOf(purchase.planKey)
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
