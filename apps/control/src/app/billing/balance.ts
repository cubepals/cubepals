/**
 * A balance: what an account owes that the billing provider can no longer collect on its own (a
 * renewal carrying extra play whose subscription ended, which the provider voids), paid as a
 * one-time order of the provider's balance product (`settleUrl`), and that order's word clearing
 * the orders it names. Only an order for the balance product that covers what those orders came to,
 * before tax, clears them; anything else is kept on the account's audit log and the debt stays.
 *
 * It is not where an order becomes owed (`persistence.ts` `owing`) or where the block it puts on
 * servers is enforced (the policy).
 */
import { type Queryable, schema } from '@blockly/db'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { BillingOrder } from '../ports/optional.ts'
import { owing, UNPAID_ORDER } from './persistence.ts'

const orders = schema.billingOrders
const subscriptions = schema.billingSubscriptions

/**
 * What of what the account owes the provider can no longer collect itself, and so is paid as a
 * balance (`settleUrl`): charges whose subscription ended, which the provider voids. One still
 * retried is paid by fixing the card in the portal instead, so it is never paid twice. `cents` is
 * what they came to before tax, which the balance is priced at; `totalCents`, with their tax, is
 * what the owner is told they pay.
 */
export async function settleable(
  q: Queryable,
  userId: string,
): Promise<{ cents: number; totalCents: number; orders: string[] }> {
  const ended = sql`(${orders.status} = 'void' or exists (select 1 from ${subscriptions} where ${subscriptions.externalSubscriptionId} = ${orders.externalSubscriptionId} and ${subscriptions.status} = 'ended'))`
  const rows = await q
    .select({ id: orders.externalOrderId, net: orders.netCents, total: orders.totalCents })
    .from(orders)
    .where(and(owing(userId), ended))
    .orderBy(orders.externalOrderId)
  return {
    cents: rows.reduce((sum, row) => sum + row.net, 0),
    totalCents: rows.reduce((sum, row) => sum + row.total, 0),
    orders: rows.map((row) => row.id),
  }
}

/**
 * What a balance order's word does. Paid, it clears the orders it names that are still unpaid,
 * when it covers them: its amount before tax is at least theirs. One that falls short (a discount,
 * an amount changed on the way) clears nothing and is kept on the audit log for an admin, and the
 * debt stays. Whatever it paid past what was still owed (the same orders paid twice, or paid by
 * card since) is answered as `refundCents`, before tax, to be given back. Orders it cleared
 * already stay cleared, so the provider's word again changes nothing. Refunded, so that less is
 * left of it than what it cleared, they are owed again.
 */
export async function settleWith(
  q: Queryable,
  provider: string,
  order: BillingOrder,
): Promise<{ refundCents: number }> {
  const none = { refundCents: 0 }
  if (!order.balance || order.userId === null || order.settles.length === 0) return none
  if (order.refundedCents > 0) {
    await unsettle(q, provider, order)
    return none
  }
  if (order.status !== 'paid') return none
  const named = await q
    .select({ id: orders.externalOrderId, net: orders.netCents, settledBy: orders.settledBy })
    .from(orders)
    .where(
      and(
        eq(orders.provider, provider),
        eq(orders.userId, order.userId),
        inArray(orders.externalOrderId, order.settles),
        inArray(orders.status, UNPAID_ORDER),
      ),
    )
  // Its own word again: what it cleared stays cleared, and nothing is given back twice.
  if (named.some((row) => row.settledBy === order.externalOrderId)) return none
  const open = named.filter((row) => row.settledBy === null)
  const owedNet = open.reduce((sum, row) => sum + row.net, 0)
  const facts = { order: order.externalOrderId, paidCents: order.netCents, owedCents: owedNet }
  if (order.netCents < owedNet) {
    await audit(q, order, 'billing.balance_short', { ...facts, orders: open.map((row) => row.id) })
    return none
  }
  if (open.length > 0) {
    await q
      .update(orders)
      .set({ settledBy: order.externalOrderId, updatedAt: new Date() })
      .where(
        and(
          eq(orders.provider, provider),
          inArray(
            orders.externalOrderId,
            open.map((row) => row.id),
          ),
          isNull(orders.settledBy),
        ),
      )
    await audit(q, order, 'billing.balance_settled', { ...facts, orders: open.map((row) => row.id) })
  }
  return { refundCents: order.netCents - owedNet }
}

/**
 * A balance order refunded: when what is left of it no longer covers the orders it cleared, they
 * are owed again, as they were.
 */
async function unsettle(q: Queryable, provider: string, order: BillingOrder): Promise<void> {
  const cleared = await q
    .select({ id: orders.externalOrderId, net: orders.netCents })
    .from(orders)
    .where(and(eq(orders.provider, provider), eq(orders.settledBy, order.externalOrderId)))
  const clearedNet = cleared.reduce((sum, row) => sum + row.net, 0)
  if (cleared.length === 0 || order.netCents - order.refundedCents >= clearedNet) return
  await q
    .update(orders)
    .set({ settledBy: null, updatedAt: new Date() })
    .where(and(eq(orders.provider, provider), eq(orders.settledBy, order.externalOrderId)))
  await audit(q, order, 'billing.balance_refunded', {
    order: order.externalOrderId,
    refundedCents: order.refundedCents,
    owedCents: clearedNet,
    orders: cleared.map((row) => row.id),
  })
}

/**
 * Claims the refund of a balance order for this caller, once: false when it was asked for already,
 * so a webhook delivered twice never refunds twice. `release` gives it back when the provider
 * didn't take the refund, for the provider's next delivery to try again.
 */
export async function claimRefund(q: Queryable, provider: string, externalOrderId: string) {
  const claimed = await q
    .update(orders)
    .set({ refundAskedAt: new Date() })
    .where(
      and(
        eq(orders.provider, provider),
        eq(orders.externalOrderId, externalOrderId),
        isNull(orders.refundAskedAt),
      ),
    )
    .returning({ id: orders.externalOrderId })
  return {
    claimed: claimed.length > 0,
    release: () =>
      q
        .update(orders)
        .set({ refundAskedAt: null })
        .where(and(eq(orders.provider, provider), eq(orders.externalOrderId, externalOrderId))),
  }
}

/** A balance paid past what was owed was refunded: kept on the account's audit log. */
export const auditRefund = (q: Queryable, order: BillingOrder, cents: number) =>
  audit(q, order, 'billing.balance_overpaid_refunded', {
    order: order.externalOrderId,
    refundCents: cents,
    orders: order.settles,
  })

function audit(q: Queryable, order: BillingOrder, action: string, data: Record<string, unknown>) {
  return q.insert(schema.auditLog).values({
    actor: 'system:billing',
    action,
    subjectType: 'account',
    subjectId: order.userId ?? '',
    data,
  })
}
