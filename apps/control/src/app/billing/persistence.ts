import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm'
import type { BillingOrder } from '../ports/optional.ts'

const subscriptions = schema.billingSubscriptions

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
 * order (paid, then refunded) updates it. A refund only ever grows, so a paid delivery the
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
        updatedAt: new Date(),
      },
    })
  return true
}
