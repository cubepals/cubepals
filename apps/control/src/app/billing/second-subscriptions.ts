// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A second subscription to time already paid for: one for the plan in force that the provider made
 * after the subscription paying for it (two checkouts open at once, both paid), or one made after a
 * year that pays for its plan or a larger one. Each is set to end with the month it paid for, as a
 * smaller plan's is, and what it charged is refunded through the provider at once, once, and
 * audited. The subscription that was there first is never touched for one made after it.
 *
 * Not here: a smaller plan's subscription beside a larger one, which is only set to end
 * (`smallerRenewing`), and a year bought while a subscription renews (`BillingService.#yearPaid`).
 */
import { type Db, type Queryable, schema } from '@blockly/db'
import { and, eq, gt, sql } from 'drizzle-orm'
import { PAID_PLANS } from '../../domain/account/entitlements.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import type { BillingOrder, BillingProvider, BillingStanding, BillingState } from '../ports/optional.ts'
import { claimRefund, releaseRefund } from './balance.ts'
import { PAID_ORDER } from './persistence.ts'

const orders = schema.billingOrders
const log = schema.auditLog

type Subscription = NonNullable<BillingState['subscription']>
type Other = NonNullable<BillingState['others']>[number]

const STOPPED = 'billing.second_subscription_stopped'
const WHY = 'A second subscription to time already paid for.'

/** Whether the subscription was stopped as a second one (`stopSecondSubscriptions`). */
export async function stoppedAsSecond(q: Queryable, userId: string, subscription: string): Promise<boolean> {
  const [marked] = await q
    .select({ id: log.id })
    .from(log)
    .where(
      and(
        eq(log.action, STOPPED),
        eq(log.subjectId, userId),
        sql`${log.data}->>'subscription' = ${subscription}`,
      ),
    )
    .limit(1)
  return marked !== undefined
}

/**
 * Each second subscription the standing lists, beside the subscription in force or as it, set to
 * end where it still renews, marked so its charges are refunded, and its charges kept so far
 * refunded, each on its own: one the provider refuses is audited and the rest still asked for.
 * `reach` is the caller's way of asking the provider.
 */
export async function stopSecondSubscriptions(
  db: Db,
  billing: BillingProvider,
  state: BillingStanding,
  reach: <T>(call: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const paid = state.subscription
  if (paid === null) return
  for (const second of await secondsOf(db, state.userId, paid, state.others ?? [])) {
    if (!second.cancelAtPeriodEnd) await reach(() => billing.stopRenewing(second.externalSubscriptionId))
    await markStopped(db, state.userId, second, paid)
    const charged = await db
      .select({
        externalOrderId: orders.externalOrderId,
        status: orders.status,
        netCents: orders.netCents,
        refundedCents: orders.refundedCents,
      })
      .from(orders)
      .where(
        and(
          eq(orders.provider, billing.provider),
          eq(orders.userId, state.userId),
          eq(orders.externalSubscriptionId, second.externalSubscriptionId),
        ),
      )
    for (const order of charged) {
      try {
        await reach(() => refundCharge(db, billing, state.userId, second.externalSubscriptionId, order))
      } catch (error) {
        // The standing is saved whatever the provider says of one refund; it is asked again later.
        await refundNotTaken(db, state.userId, second.externalSubscriptionId, order.externalOrderId, error)
      }
    }
  }
}

/**
 * A refund the provider didn't take (refunded by hand already, too old), audited. Its claim was
 * released (`refundCharge`), so the order's next word, or the next sync, asks for it again.
 */
async function refundNotTaken(db: Db, userId: string, subscription: string, order: string, error: unknown) {
  await db.insert(log).values({
    actor: 'system:billing',
    action: 'billing.second_subscription_refund_not_taken',
    subjectType: 'account',
    subjectId: userId,
    data: { order, subscription, error: error instanceof Error ? error.message : String(error) },
  })
}

/**
 * An order's word (`BillingService.receiveWebhook`): a charge of a subscription stopped as a
 * second one is refunded, as `stopSecondSubscriptions` refunds those it finds kept already. A
 * refund the provider doesn't take is audited and the rest of the order's word goes on: the next
 * sync, or the order's next word, asks for it again.
 */
export async function refundSecondCharge(
  db: Db,
  capabilities: DeploymentCapabilities,
  order: BillingOrder,
): Promise<void> {
  const sub = order.externalSubscriptionId
  if (order.userId === null || sub === null || !PAID_ORDER.includes(order.status)) return
  if (!(await stoppedAsSecond(db, order.userId, sub))) return
  const userId = order.userId
  await refundCharge(db, requireCapability(capabilities, 'billing'), userId, sub, order).catch(
    (error: unknown) => refundNotTaken(db, userId, sub, order.externalOrderId, error),
  )
}

/**
 * The standing's second subscriptions: for the plan in force, made after the one paying for it
 * while that one still renews; and any, the one in force too, made after a year still to run that
 * pays for its plan or a larger one. One whose making the provider doesn't date is left alone.
 */
async function secondsOf(
  db: Db,
  userId: string,
  paid: Subscription,
  others: readonly Other[],
): Promise<Array<Subscription | Other>> {
  const made = (sub: { createdAt?: Date }) => sub.createdAt?.getTime() ?? null
  const after = (sub: { createdAt?: Date }, at: number | null) => {
    const time = made(sub)
    return time !== null && at !== null && time > at
  }
  const again = paid.cancelAtPeriodEnd
    ? []
    : others.filter((other) => other.planKey === paid.planKey && after(other, made(paid)))
  const years = await db
    .select({ planKey: schema.planYears.planKey, orderedAt: orders.orderedAt })
    .from(schema.planYears)
    .innerJoin(
      orders,
      and(
        eq(orders.provider, schema.planYears.provider),
        eq(orders.externalOrderId, schema.planYears.externalOrderId),
      ),
    )
    .where(
      and(
        eq(schema.planYears.userId, userId),
        gt(schema.planYears.endsAt, new Date()),
        gt(schema.planYears.endsAt, schema.planYears.startsAt),
      ),
    )
  const besideYear = [paid, ...others].filter((sub) =>
    years.some(
      (year) =>
        PAID_PLANS.indexOf(sub.planKey) <= PAID_PLANS.indexOf(year.planKey) &&
        after(sub, year.orderedAt.getTime()),
    ),
  )
  const seconds = new Map([...again, ...besideYear].map((sub) => [sub.externalSubscriptionId, sub]))
  return [...seconds.values()]
}

/** Kept on the account's audit log, once: what its charges are refunded by (`refundSecondCharge`). */
async function markStopped(db: Db, userId: string, second: Subscription | Other, paid: Subscription) {
  if (await stoppedAsSecond(db, userId, second.externalSubscriptionId)) return
  await db.insert(log).values({
    actor: 'system:billing',
    action: STOPPED,
    subjectType: 'account',
    subjectId: userId,
    data: {
      subscription: second.externalSubscriptionId,
      plan: second.planKey,
      ...(second.externalSubscriptionId === paid.externalSubscriptionId
        ? {}
        : { besides: paid.externalSubscriptionId }),
    },
  })
}

/**
 * What a second subscription's order paid and still holds, before tax, refunded through the
 * provider once (`claimRefund`) and audited. One the provider doesn't take is released, and asked
 * for again with the next word about it.
 */
async function refundCharge(
  db: Db,
  billing: BillingProvider,
  userId: string,
  subscription: string,
  order: Pick<BillingOrder, 'externalOrderId' | 'status' | 'netCents' | 'refundedCents'>,
): Promise<void> {
  const cents = order.netCents - order.refundedCents
  if (!PAID_ORDER.includes(order.status) || cents <= 0) return
  if (!(await claimRefund(db, billing.provider, order.externalOrderId))) return
  try {
    await billing.refund({ externalOrderId: order.externalOrderId, cents, why: WHY })
  } catch (error) {
    await releaseRefund(db, billing.provider, order.externalOrderId)
    throw error
  }
  await db.insert(log).values({
    actor: 'system:billing',
    action: 'billing.second_subscription_refunded',
    subjectType: 'account',
    subjectId: userId,
    data: { order: order.externalOrderId, subscription, refundCents: cents },
  })
}
