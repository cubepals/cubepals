import { type Queryable, schema, type Tx } from '@blockly/db'
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { type BillingFacts, type ExtraPlay, extraPlay } from '../../domain/account/extra-play.ts'
import type { AccountStanding } from '../../domain/account/standing.ts'
import type { BillingOrder } from '../ports/optional.ts'

const subscriptions = schema.billingSubscriptions

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
export const RENEWAL_GRACE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * A renewal that failed to charge: the plan lasts this long from the failure while the provider
 * retries the card (Polar tries again 2, 7, 14 and 21 days after it), so one declined charge never
 * stops anyone's server. A retry that succeeds later brings the plan back.
 */
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

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
  updatedAt: Date
}

/** The plan a paying subscription gives the account now, if it has one. */
export async function billedPlan(q: Queryable, userId: string, now = new Date()): Promise<string | null> {
  const [row] = await q
    .select({ planKey: subscriptions.planKey })
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
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1)
  return row?.planKey ?? null
}

/** The account's newest subscription, paying or not, for the account page. */
export async function latestSubscription(q: Queryable, userId: string): Promise<SubscriptionRecord | null> {
  const [row] = await q
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1)
  return row ?? null
}

/**
 * What the provider says now about the subscription that pays, replacing what it said before: a
 * renewal that failed and was then paid is no longer past due.
 */
export async function saveSubscription(
  tx: Tx,
  subscription: Omit<SubscriptionRecord, 'updatedAt' | 'pastDueAt'>,
): Promise<void> {
  await tx
    .insert(subscriptions)
    .values({ ...subscription, pastDueAt: null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [subscriptions.provider, subscriptions.externalSubscriptionId],
      set: {
        userId: subscription.userId,
        externalCustomerId: subscription.externalCustomerId,
        planKey: subscription.planKey,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        pastDueAt: null,
        updatedAt: new Date(),
      },
    })
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
    .set({ status: 'ended', updatedAt: new Date() })
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
 * never made isn't its revenue; false then, and nothing is kept.
 */
export async function recordOrder(q: Queryable, provider: string, order: BillingOrder): Promise<boolean> {
  if (order.userId === null) return false
  const [known] = await q
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, order.userId))
  if (known === undefined) return false
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
        updatedAt: new Date(),
      },
    })
  return true
}

const orders = schema.billingOrders

/**
 * An order carrying extra play is never owed younger than this: the provider tries its charge
 * first, and a subscription that ends makes its final charge pending a while before it is tried.
 */
const OWED_AFTER_MS = 60 * 60_000

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
 * of the first two, which are owed only once their charge has failed or they are void.
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
        lt(orders.orderedAt, new Date(now.getTime() - OWED_AFTER_MS)),
        or(ended, lt(orders.orderedAt, new Date(now.getTime() - PAST_DUE_GRACE_MS))),
      ),
    )
  return rows.map(({ old, ended, ...row }) => ({ ...row, ended: ended && !old }))
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

/** What the billing provider has said about an account, as extra play's guards read it. */
export async function billingFacts(q: Queryable, userId: string): Promise<BillingFacts> {
  const latest = await latestSubscription(q, userId)
  const paid = and(
    eq(orders.userId, userId),
    sql`${orders.planKey} is not null`,
    inArray(orders.status, PAID_ORDER),
    gt(orders.netCents, 0),
    lt(orders.refundedCents, orders.totalCents),
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
  return rows.map((row) => row.userId)
}

/**
 * Charges carrying extra play that failed while the provider still retries them (their
 * subscription past due), that the owner hasn't been told about yet.
 */
export async function failingUntold(q: Queryable, userId: string): Promise<OrderNotice[]> {
  return q
    .select({
      provider: orders.provider,
      externalOrderId: orders.externalOrderId,
      totalCents: orders.totalCents,
      extraCents: orders.extraCents,
      orderedAt: orders.orderedAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        gt(orders.extraCents, 0),
        inArray(orders.status, ['pending']),
        isNull(orders.settledBy),
        isNull(orders.failureToldAt),
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
 * Whether the account may play past its included hours now, and how far, with what it owes:
 * every place that counts extra play (the policy, the sweep that stops servers, the account page,
 * the reporter) reads it from here.
 */
export async function extraPlayNow(
  q: Queryable,
  standing: AccountStanding,
): Promise<{ decision: ExtraPlay; owedCents: number }> {
  const facts = await billingFacts(q, standing.userId)
  const plan = entitlementsFor(standing.plan, standing.limitOverrides)
  return { decision: extraPlay(plan, standing.extraUnitsAllowed, facts), owedCents: facts.owedCents }
}
