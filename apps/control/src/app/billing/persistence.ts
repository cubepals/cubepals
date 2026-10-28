// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { DAY_MS, HOUR_MS } from '@blockly/contracts/durations'
import { type Queryable, schema, type Tx } from '@blockly/db'
import {
  type AnyColumn,
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { entitlementsOf } from '../../domain/account/entitlements.ts'
import { type BillingFacts, type ExtraPlay, extraPlay } from '../../domain/account/extra-play.ts'
import type { AccountStanding, SoldTerms } from '../../domain/account/standing.ts'
import type { BillingOrder } from '../ports/optional.ts'
import { tuning } from '../tuning.ts'

const subscriptions = schema.billingSubscriptions
const gifts = schema.planGifts

/** Statuses of an order that was paid: refunded ones too, for what was refunded is kept apart. */
export const PAID_ORDER = ['paid', 'partially_refunded', 'refunded']

/** Statuses of an order whose charge hasn't gone through, or never will: nothing was paid. */
export const UNPAID_ORDER = ['draft', 'pending', 'void']

/** Statuses a provider reports for a subscription that pays for its plan. */
export const PAYING = ['active', 'trialing']

/**
 * A renewal the provider hasn't reported yet: a paid period that just ended still counts for
 * this long, so a late webhook never takes a plan away for a moment.
 */
export const RENEWAL_GRACE_MS = 3 * DAY_MS

/**
 * A renewal that failed to charge: the plan lasts this long from the failure while the provider
 * retries the card (Polar tries again 2, 7, 14 and 21 days after it), so one declined charge never
 * stops anyone's server. A retry that succeeds later brings the plan back.
 */
export const PAST_DUE_GRACE_MS = 7 * DAY_MS

/**
 * Which of an account's subscriptions speaks for it: one that pays before one past due, before
 * one that ended, and of those the one made last. Never the one written last: a past-due one is
 * written on every sync, and must not hide a newer one that pays.
 */
const NEWEST = [
  sql`case ${subscriptions.status} when 'active' then 0 when 'trialing' then 0 when 'past_due' then 1 else 2 end`,
  desc(subscriptions.createdAt),
  desc(subscriptions.updatedAt),
]

export interface SubscriptionRecord {
  userId: string
  provider: string
  externalCustomerId: string
  externalSubscriptionId: string
  planKey: string
  status: string
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  pastDueAt: Date | null
  canceledAt: Date | null
  /** A smaller plan it moves to at `movesAt`, the end of the period paid for; null: it stays. */
  movesToPlan: string | null
  movesAt: Date | null
  /** The provider's product it is on, and what it was sold with there (`SoldTerms`), all null on a plan's own. */
  productId: string | null
  priceCents: number | null
  includedUnits: number | null
  mostExtraUnits: number | null
  createdAt: Date
  updatedAt: Date
}

/** What a subscription on a product was sold with, as `saveSubscription` is told it. */
export interface SavedTerms {
  productId: string | null
  terms: SoldTerms | null
}

/**
 * The plan a paying subscription gives the account now, or else a year paid for, or else a
 * redeemed gift (`giftedPlan`); null when none does. One statement asks all three in that order:
 * every entitlement is read through here, sweeps every minute included.
 */
export async function billedPlan(q: Queryable, userId: string, now = new Date()): Promise<string | null> {
  return (await billedBy(q, userId, now))?.plan ?? null
}

/** What the paying subscription row holds of its terms, read in one go with its plan. */
const paidTerms = sql<{
  plan: string
  price: number | null
  units: number | null
  most: number | null
}>`json_build_object('plan', ${subscriptions.planKey}, 'price', ${subscriptions.priceCents}, 'units', ${subscriptions.includedUnits}, 'most', ${subscriptions.mostExtraUnits})`

/** What gives the account a plan now (`billedPlan`): a subscription, a year paid at once, or a gift. */
export type PlanSource = 'subscription' | 'year' | 'gift'

/** `billedPlan`, with which of the three gives it. */
export async function billedBy(
  q: Queryable,
  userId: string,
  now = new Date(),
): Promise<{ plan: string; from: PlanSource; soldWith?: SoldTerms } | null> {
  const paying = q
    .select({ paid: paidTerms })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        or(
          and(
            inArray(subscriptions.status, PAYING),
            or(
              isNull(subscriptions.currentPeriodEnd),
              gt(subscriptions.currentPeriodEnd, new Date(now.getTime() - RENEWAL_GRACE_MS)),
            ),
          ),
          and(
            eq(subscriptions.status, 'past_due'),
            gt(subscriptions.pastDueAt, new Date(now.getTime() - PAST_DUE_GRACE_MS)),
          ),
        ),
      ),
    )
    .orderBy(...NEWEST)
    .limit(1)
  // A year paid at once, running now (`plan_years`).
  const year = q
    .select({ planKey: schema.planYears.planKey })
    .from(schema.planYears)
    .where(
      and(
        eq(schema.planYears.userId, userId),
        lte(schema.planYears.startsAt, now),
        gt(schema.planYears.endsAt, now),
      ),
    )
    .limit(1)
  const gift = giftRunning(q, userId, now)
  const { rows } = await q.execute<{
    subscription: { plan: string; price: number | null; units: number | null; most: number | null } | null
    year: string | null
    gift: string | null
  }>(sql`select (${paying}) as subscription, (${year}) as year, (${gift}) as gift`)
  const row = rows[0]
  const paid = row?.subscription
  if (paid) {
    const soldWith =
      paid.price === null || paid.units === null
        ? undefined
        : { priceCents: paid.price, includedUnits: paid.units, mostExtraUnits: paid.most }
    return { plan: paid.plan, from: 'subscription', ...(soldWith === undefined ? {} : { soldWith }) }
  }
  if (row?.year) return { plan: row.year, from: 'year' }
  if (row?.gift) return { plan: row.gift, from: 'gift' }
  return null
}

/** The redeemed gift running now that began first, as `giftedPlan` reads it. */
const giftRunning = (q: Queryable, userId: string, now: Date) =>
  q
    .select({ planKey: gifts.planKey })
    .from(gifts)
    .where(
      and(
        eq(gifts.redeemedBy, userId),
        isNull(gifts.voidedAt),
        isNotNull(gifts.planKey),
        lte(gifts.startsAt, now),
        gt(gifts.endsAt, now),
      ),
    )
    .orderBy(gifts.startsAt)
    .limit(1)

/** The plan a redeemed gift gives the account now, and until when; null when none does. */
export async function giftedPlan(
  q: Queryable,
  userId: string,
  now = new Date(),
): Promise<{ planKey: string; until: Date } | null> {
  const [row] = await q
    .select({ planKey: gifts.planKey, endsAt: gifts.endsAt })
    .from(gifts)
    .where(
      and(
        eq(gifts.redeemedBy, userId),
        isNull(gifts.voidedAt),
        isNotNull(gifts.planKey),
        lte(gifts.startsAt, now),
        gt(gifts.endsAt, now),
      ),
    )
    .orderBy(gifts.startsAt)
    .limit(1)
  if (!row?.planKey || !row.endsAt) return null
  // Gifts redeemed one after another run on from each other: the plan lasts until the last ends.
  const [last] = await q
    .select({ endsAt: sql<Date>`max(${gifts.endsAt})` })
    .from(gifts)
    .where(and(eq(gifts.redeemedBy, userId), isNull(gifts.voidedAt), eq(gifts.planKey, row.planKey)))
  return { planKey: row.planKey, until: last?.endsAt ? new Date(last.endsAt) : row.endsAt }
}

/** The account's subscription that speaks for it (`NEWEST`), paying or not, for the account page. */
export async function latestSubscription(q: Queryable, userId: string): Promise<SubscriptionRecord | null> {
  const [row] = await q
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(...NEWEST)
    .limit(1)
  return row ?? null
}

/**
 * What the provider says now about the subscription that pays, replacing what it said before: a
 * renewal that failed and was then paid is no longer past due.
 */
export async function saveSubscription(
  tx: Tx,
  {
    productId,
    terms,
    ...subscription
  }: Omit<
    SubscriptionRecord,
    | 'updatedAt'
    | 'pastDueAt'
    | 'createdAt'
    | 'movesToPlan'
    | 'movesAt'
    | 'productId'
    | 'priceCents'
    | 'includedUnits'
    | 'mostExtraUnits'
  > &
    Partial<SavedTerms> & {
      createdAt?: Date
    },
): Promise<void> {
  const made = subscription.createdAt === undefined ? {} : { createdAt: subscription.createdAt }
  const sold = soldColumns(productId, terms)
  // Set to end: when the provider says, or else the first Blockly heard of it. Renewing: never.
  const canceledAt = subscription.cancelAtPeriodEnd ? (subscription.canceledAt ?? new Date()) : null
  await tx
    .insert(subscriptions)
    .values({ ...subscription, ...made, ...sold, canceledAt, pastDueAt: null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [subscriptions.provider, subscriptions.externalSubscriptionId],
      set: {
        userId: subscription.userId,
        externalCustomerId: subscription.externalCustomerId,
        planKey: subscription.planKey,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        ...made,
        canceledAt:
          subscription.cancelAtPeriodEnd && subscription.canceledAt === null
            ? sql`coalesce(${subscriptions.canceledAt}, ${canceledAt})`
            : canceledAt,
        pastDueAt: null,
        ...soldOnChange(sold),
        // A move to a smaller plan is done once the provider says the subscription is on it, and
        // off once it says the subscription ends: nothing moves from a plan that is ending.
        ...(subscription.cancelAtPeriodEnd
          ? { movesToPlan: null, movesAt: null }
          : {
              movesToPlan: sql`case when ${subscriptions.movesToPlan} = ${subscription.planKey} then null else ${subscriptions.movesToPlan} end`,
              movesAt: sql`case when ${subscriptions.movesToPlan} = ${subscription.planKey} then null else ${subscriptions.movesAt} end`,
            }),
        updatedAt: new Date(),
      },
    })
}

/** The columns a subscription's product and terms are kept in; nothing when the provider named no product. */
function soldColumns(productId: string | null | undefined, terms: SoldTerms | null | undefined) {
  if (productId === undefined || productId === null) return {}
  return {
    productId,
    priceCents: terms?.priceCents ?? null,
    includedUnits: terms?.includedUnits ?? null,
    mostExtraUnits: terms?.mostExtraUnits ?? null,
  }
}

/**
 * The terms a subscription was sold with stay while it is on that product: only a move to another
 * product (a plan bought over it, the price of the day taken) sets them again, from the new one.
 */
function soldOnChange(sold: ReturnType<typeof soldColumns>) {
  if (sold.productId === undefined) return {}
  const moved = sql`${subscriptions.productId} is distinct from ${sold.productId}`
  const kept = (column: AnyColumn, value: number | null) =>
    sql`case when ${moved} then ${value}::integer else ${column} end`
  return {
    productId: sold.productId,
    priceCents: kept(subscriptions.priceCents, sold.priceCents),
    includedUnits: kept(subscriptions.includedUnits, sold.includedUnits),
    mostExtraUnits: kept(subscriptions.mostExtraUnits, sold.mostExtraUnits),
  }
}

/** A move to a smaller plan at `at`, the end of the period paid for, as the provider took it. */
export async function recordMove(
  q: Queryable,
  provider: string,
  externalSubscriptionId: string,
  plan: string,
  at: Date,
): Promise<void> {
  await q
    .update(subscriptions)
    .set({ movesToPlan: plan, movesAt: at, updatedAt: new Date() })
    .where(
      and(
        eq(subscriptions.provider, provider),
        eq(subscriptions.externalSubscriptionId, externalSubscriptionId),
      ),
    )
}

const otherOpen = (userId: string, provider: string, keep: string | null) =>
  and(
    eq(subscriptions.userId, userId),
    eq(subscriptions.provider, provider),
    ne(subscriptions.status, 'ended'),
    ...(keep === null ? [] : [ne(subscriptions.externalSubscriptionId, keep)]),
  )

/**
 * The account's subscriptions at this provider that haven't ended, other than the one that pays
 * now: the ones a new standing leaves out, which have either ended or gone past due.
 */
export async function subscriptionsLeftOut(
  q: Queryable,
  userId: string,
  provider: string,
  keep: string | null,
): Promise<string[]> {
  const rows = await q
    .select({ id: subscriptions.externalSubscriptionId })
    .from(subscriptions)
    .where(otherOpen(userId, provider, keep))
  return rows.map((row) => row.id)
}

/**
 * The account's other subscriptions at this provider that still pay and still renew, with the plan
 * each is for: what a plan bought over them leaves to run out (`Billing.syncSubscription`).
 */
export async function otherRenewing(
  q: Queryable,
  userId: string,
  provider: string,
  keep: string | null,
): Promise<Array<{ id: string; planKey: string }>> {
  const rows = await q
    .select({ id: subscriptions.externalSubscriptionId, planKey: subscriptions.planKey })
    .from(subscriptions)
    .where(
      and(
        otherOpen(userId, provider, keep),
        inArray(subscriptions.status, PAYING),
        eq(subscriptions.cancelAtPeriodEnd, false),
      ),
    )
  return rows
}

/**
 * Every other subscription of the account at this provider stops paying: the ones in `pastDue`
 * are past due since then, while the provider retries them, and the rest have ended.
 */
export async function settleOtherSubscriptions(
  tx: Tx,
  userId: string,
  provider: string,
  keep: string | null,
  pastDue: ReadonlyMap<string, Date>,
): Promise<void> {
  for (const [id, since] of pastDue)
    await tx
      .update(subscriptions)
      .set({ status: 'past_due', pastDueAt: since, updatedAt: new Date() })
      .where(and(otherOpen(userId, provider, keep), eq(subscriptions.externalSubscriptionId, id)))
  await tx
    .update(subscriptions)
    .set({
      status: 'ended',
      canceledAt: sql`coalesce(${subscriptions.canceledAt}, now())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        otherOpen(userId, provider, keep),
        ...(pastDue.size === 0
          ? []
          : [notInArray(subscriptions.externalSubscriptionId, [...pastDue.keys()])]),
      ),
    )
}

/**
 * An order as the provider reports it, kept by its id: a redelivered or later event about the same
 * order (made, then paid, then refunded) updates it. A refund only ever grows, so a paid delivery the
 * provider sends again after the refund never takes it back. An order for someone this deployment
 * never made isn't its revenue. An order for a gift made before its checkout (`giftId`) is its
 * buyer's (`byGift`): a guest's is kept with no account, with GIFTS_BY_EMAIL on. Answers the order
 * as kept, or null when nothing is.
 */
export async function recordOrder(
  q: Queryable,
  provider: string,
  delivered: BillingOrder,
): Promise<BillingOrder | null> {
  const order = await byGift(q, delivered)
  if (order === null) return null
  if (order.userId === null) {
    if (!order.giftId || tuning().giftsByEmail !== true) return null
  } else {
    const [known] = await q
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, order.userId))
    if (known === undefined) return null
  }
  const row = {
    userId: order.userId,
    planKey: order.planKey,
    billingReason: order.billingReason,
    currency: order.currency,
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    netCents: order.netCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    refundedCents: order.refundedCents,
    status: order.status,
    extraCents: order.extraCents,
    externalSubscriptionId: order.externalSubscriptionId,
    giftId: order.giftId ?? null,
    orderedAt: order.orderedAt,
  }
  await q
    .insert(schema.billingOrders)
    .values({ provider, externalOrderId: order.externalOrderId, ...row })
    .onConflictDoUpdate({
      target: [schema.billingOrders.provider, schema.billingOrders.externalOrderId],
      set: {
        ...row,
        refundedCents: sql`greatest(${schema.billingOrders.refundedCents}, ${order.refundedCents})`,
        // Word that an order is waiting for its charge, arriving after word that it was paid, is
        // older word: a paid order stays paid. One a balance paid keeps the provider's word, and
        // `settledBy` says it is paid all the same.
        status: sql`case when ${schema.billingOrders.status} in ('paid', 'partially_refunded', 'refunded') and ${order.status} in ('draft', 'pending') then ${schema.billingOrders.status} else ${order.status} end`,
        // The provider's word about it: it knows the order after all (`markUnknown`).
        unknownAt: null,
        updatedAt: new Date(),
      },
    })
  return order
}

/**
 * The order as the gift it names says it (`giftId`): paid by the gift's buyer, an account or a
 * guest, whatever account the provider filed it under. Polar files a guest's order under the
 * customer with their email, which is an account's when one has it, and says nothing of who
 * bought the gift. An order naming a gift this deployment never made is not its order: null.
 */
async function byGift(q: Queryable, order: BillingOrder): Promise<BillingOrder | null> {
  if (!order.giftId) return order
  const [gift] = await q.select({ buyerId: gifts.buyerId }).from(gifts).where(eq(gifts.id, order.giftId))
  return gift === undefined ? null : { ...order, userId: gift.buyerId }
}

const orders = schema.billingOrders

/**
 * An order carrying extra play is never owed younger than this: the provider tries its charge
 * first, and a subscription that ends makes its final charge pending a while before it is tried.
 */
const OWED_AFTER_MS = HOUR_MS

/** An order the provider said it doesn't know (`markUnknown`) is read again after this long. */
const UNKNOWN_RETRY_MS = DAY_MS

/** Not one the provider said it doesn't know in the last `UNKNOWN_RETRY_MS`. */
const notUnknown = (now: Date) =>
  or(isNull(orders.unknownAt), lt(orders.unknownAt, new Date(now.getTime() - UNKNOWN_RETRY_MS)))

/**
 * Charges carrying extra play that didn't go through and won't now: the provider was asked again
 * and said so (`confirmOwed`), from `owedAt`. What the account owes is all of each, the plan's own
 * price with the extra; one paid since, or settled by a balance, is owed no more.
 */
export function owing(userId: string) {
  return and(
    eq(orders.userId, userId),
    gt(orders.extraCents, 0),
    inArray(orders.status, UNPAID_ORDER),
    isNull(orders.settledBy),
    isNotNull(orders.owedAt),
  )
}

/**
 * Orders that may be owed now, for the provider to be asked about again before they are: unpaid,
 * carrying extra play, at least `OWED_AFTER_MS` old, and either void, of a subscription that has
 * ended, or past the grace a failed renewal gets while the card is tried again. `ended` says which
 * of the first two, which are owed only once their charge has failed or they are void. One the
 * provider said it doesn't know waits a day (`markUnknown`).
 */
export async function mayBeOwed(
  q: Queryable,
  now: Date,
): Promise<Array<{ provider: string; externalOrderId: string; userId: string; ended: boolean }>> {
  const ended = sql<boolean>`(${orders.status} = 'void' or exists (select 1 from ${subscriptions} where ${subscriptions.externalSubscriptionId} = ${orders.externalSubscriptionId} and ${subscriptions.status} = 'ended'))`
  const rows = await q
    .select({
      provider: orders.provider,
      externalOrderId: orders.externalOrderId,
      userId: orders.userId,
      ended,
      old: sql<boolean>`${orders.orderedAt} < ${new Date(now.getTime() - PAST_DUE_GRACE_MS)}`,
    })
    .from(orders)
    .where(
      and(
        gt(orders.extraCents, 0),
        inArray(orders.status, UNPAID_ORDER),
        isNull(orders.settledBy),
        isNull(orders.owedAt),
        notUnknown(now),
        lt(orders.orderedAt, new Date(now.getTime() - OWED_AFTER_MS)),
        or(ended, lt(orders.orderedAt, new Date(now.getTime() - PAST_DUE_GRACE_MS))),
      ),
    )
  // Only a guest's gift has no account, and a gift carries no extra play.
  return rows.flatMap(({ old, ended, userId, ...row }) =>
    userId === null ? [] : [{ ...row, userId, ended: ended && !old }],
  )
}

/** The provider said again that this order is unpaid and won't be: it is owed from `now`. */
export async function markOwed(q: Queryable, provider: string, externalOrderId: string, now: Date) {
  await q
    .update(orders)
    .set({ owedAt: now, updatedAt: now })
    .where(
      and(eq(orders.provider, provider), eq(orders.externalOrderId, externalOrderId), isNull(orders.owedAt)),
    )
}

/**
 * The provider, asked again about an order, said it doesn't know it: it isn't read again for a day
 * (`UNKNOWN_RETRY_MS`). The account it is for the first time it is said, else null, so it is
 * audited and logged once.
 */
export async function markUnknown(
  q: Queryable,
  provider: string,
  externalOrderId: string,
  now: Date,
): Promise<string | null> {
  const which = and(eq(orders.provider, provider), eq(orders.externalOrderId, externalOrderId))
  const [first] = await q
    .update(orders)
    .set({ unknownAt: now, updatedAt: now })
    .where(and(which, isNull(orders.unknownAt)))
    .returning({ userId: orders.userId })
  if (first !== undefined) return first.userId
  await q.update(orders).set({ unknownAt: now, updatedAt: now }).where(which)
  return null
}

/** Unpaid charges carrying extra play that the provider says it doesn't know, for an admin. */
export async function unknownOrders(q: Queryable): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(orders)
    .where(
      and(
        isNotNull(orders.unknownAt),
        gt(orders.extraCents, 0),
        inArray(orders.status, UNPAID_ORDER),
        isNull(orders.settledBy),
      ),
    )
  return row?.n ?? 0
}

/** What the billing provider has said about an account, as extra play's guards read it. */
export async function billingFacts(q: Queryable, userId: string): Promise<BillingFacts> {
  const latest = await latestSubscription(q, userId)
  const paid = and(
    eq(orders.userId, userId),
    sql`${orders.planKey} is not null`,
    inArray(orders.status, PAID_ORDER),
    gt(orders.netCents, 0),
    // The refund is before tax, as the net is.
    lt(orders.refundedCents, orders.netCents),
  )
  const [all] = await q.select({ n: count() }).from(orders).where(paid)
  const [renewals] = await q
    .select({ n: count() })
    .from(orders)
    .where(and(paid, eq(orders.billingReason, 'subscription_cycle')))
  const [owed] = await q
    .select({ cents: sql<string>`coalesce(sum(${orders.totalCents}), 0)` })
    .from(orders)
    .where(owing(userId))
  return {
    subscription:
      latest === null ? null : { status: latest.status, cancelAtPeriodEnd: latest.cancelAtPeriodEnd },
    paidOrders: all?.n ?? 0,
    paidRenewals: renewals?.n ?? 0,
    owedCents: Number(owed?.cents ?? 0),
  }
}

/** An order the account is told about: what it charged, and what of it was extra play. */
export interface OrderNotice {
  provider: string
  externalOrderId: string
  totalCents: number
  extraCents: number
  orderedAt: Date
  /** The plan the order paid for; null for one that paid for none. */
  planKey: string | null
}

/** Accounts with a charge carrying extra play that failed, which they may not have heard about. */
export async function untoldAbout(q: Queryable): Promise<string[]> {
  const rows = await q
    .selectDistinct({ userId: orders.userId })
    .from(orders)
    .where(
      and(
        gt(orders.extraCents, 0),
        inArray(orders.status, UNPAID_ORDER),
        isNull(orders.settledBy),
        or(isNull(orders.failureToldAt), isNull(orders.owingToldAt)),
      ),
    )
  return rows.flatMap((row) => (row.userId === null ? [] : [row.userId]))
}

/**
 * Charges carrying extra play that failed while the provider still retries them (their
 * subscription past due), that the owner hasn't been told about yet; one the provider said it
 * doesn't know waits a day (`markUnknown`).
 */
export async function failingUntold(q: Queryable, userId: string, now: Date): Promise<OrderNotice[]> {
  return q
    .select({
      provider: orders.provider,
      externalOrderId: orders.externalOrderId,
      totalCents: orders.totalCents,
      extraCents: orders.extraCents,
      orderedAt: orders.orderedAt,
      planKey: orders.planKey,
    })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        gt(orders.extraCents, 0),
        inArray(orders.status, ['pending']),
        isNull(orders.settledBy),
        isNull(orders.failureToldAt),
        notUnknown(now),
        sql`exists (select 1 from ${subscriptions} where ${subscriptions.externalSubscriptionId} = ${orders.externalSubscriptionId} and ${subscriptions.status} = 'past_due')`,
      ),
    )
}

/** Charges the account now owes for (`owing`) that the owner hasn't been told about yet. */
export async function owingUntold(q: Queryable, userId: string): Promise<OrderNotice[]> {
  return q
    .select({
      provider: orders.provider,
      externalOrderId: orders.externalOrderId,
      totalCents: orders.totalCents,
      extraCents: orders.extraCents,
      orderedAt: orders.orderedAt,
      planKey: orders.planKey,
    })
    .from(orders)
    .where(and(owing(userId), isNull(orders.owingToldAt)))
}

/** The owner was told about these charges: that they failed, or that they are owed. */
export async function markTold(
  q: Queryable,
  told: readonly OrderNotice[],
  what: 'failure' | 'owing',
  now: Date,
): Promise<void> {
  for (const order of told)
    await q
      .update(orders)
      .set(what === 'failure' ? { failureToldAt: now } : { owingToldAt: now })
      .where(and(eq(orders.provider, order.provider), eq(orders.externalOrderId, order.externalOrderId)))
}

/**
 * When the account's extra play stopped, by its subscription's own word: when it was set to end or
 * ended, or when its renewal failed. Null while it renews and pays, or for none. Extra play is
 * counted up to here, never past.
 */
export async function extraStoppedAt(q: Queryable, userId: string): Promise<Date | null> {
  const latest = await latestSubscription(q, userId)
  if (latest === null) return null
  if (latest.status === 'past_due') return latest.pastDueAt
  if (latest.status === 'ended' || latest.cancelAtPeriodEnd) return latest.canceledAt
  return null
}

/** Why a test account plays no extra: what it plays is never sent to be billed. */
const TEST_NO_EXTRA = 'This is a test account, so extra hours are off: nothing it plays is billed.'

/**
 * Whether the account may play past its included hours now, and how far, with what it owes:
 * every place that counts extra play (the policy, the sweep that stops servers, the account page,
 * the reporter) reads it from here. Never on a test account, whose play is never sent to be
 * billed (`ExtraUsage.send`), so nothing is counted that nothing bills.
 */
export async function extraPlayNow(
  q: Queryable,
  standing: AccountStanding,
): Promise<{ decision: ExtraPlay; owedCents: number }> {
  const facts = await billingFacts(q, standing.userId)
  const plan = entitlementsOf(standing)
  return {
    decision: standing.testAccount
      ? { may: false, why: TEST_NO_EXTRA }
      : extraPlay(plan, standing.extraUnitsAllowed, facts, tuning().abuse.extraCeiling),
    owedCents: facts.owedCents,
  }
}

const months = schema.extraPlayMonths

/**
 * The block of hours the month (`month`, as `monthOf` names it) kept when an admin lowered the
 * account's hours (`keepMonthBlock`), in hours; null when none was kept, or when it was kept under
 * a plan other than `plan`, which is no longer in force.
 */
export async function monthBlock(
  q: Queryable,
  userId: string,
  month: string,
  plan: string,
): Promise<number | null> {
  const [row] = await q
    .select({ units: months.blockUnits })
    .from(months)
    .where(and(eq(months.userId, userId), eq(months.month, month), eq(months.blockPlan, plan)))
  return row?.units ?? null
}

/**
 * Keeps `units` as the month's block under `plan`, when it is more than what is kept under that
 * plan: hours an admin lowers apply from the next month (`monthBlock`).
 */
export async function keepMonthBlock(
  q: Queryable,
  userId: string,
  month: string,
  plan: string,
  units: number,
): Promise<void> {
  await q
    .insert(months)
    .values({ userId, month, blockUnits: units, blockPlan: plan })
    .onConflictDoUpdate({
      target: [months.userId, months.month],
      set: { blockUnits: units, blockPlan: plan, updatedAt: new Date() },
      setWhere: sql`${months.blockPlan} is distinct from ${plan} or ${months.blockUnits} is null or ${months.blockUnits} < ${units}`,
    })
}
