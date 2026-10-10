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
  now = new Date(),
): Promise<{ cents: number; totalCents: number; orders: string[] }> {
  const ended = sql`(${orders.status} = 'void' or exists (select 1 from ${subscriptions} where ${subscriptions.externalSubscriptionId} = ${orders.externalSubscriptionId} and ${subscriptions.status} = 'ended'))`
  const rows = await q
    .select({ id: orders.externalOrderId, net: orders.netCents, total: orders.totalCents })
    .from(orders)
    .where(and(owing(userId, now), ended))
    .orderBy(orders.externalOrderId)
  return {
    cents: rows.reduce((sum, row) => sum + row.net, 0),
    totalCents: rows.reduce((sum, row) => sum + row.total, 0),
    orders: rows.map((row) => row.id),
  }
}

/**
 * A paid balance order clears the orders it names, when it covers them: its amount before tax is
 * at least theirs. One that falls short (a discount, an amount changed on the way) clears nothing
 * and is kept on the audit log for an admin, and the debt stays. Orders it already cleared stay
 * cleared, so the provider's word again changes nothing.
 */
export async function settleWith(q: Queryable, provider: string, order: BillingOrder): Promise<void> {
  if (!order.balance || order.status !== 'paid' || order.userId === null || order.settles.length === 0) return
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
  const open = named.filter((row) => row.settledBy === null)
  if (open.length === 0) return
  const owedNet = open.reduce((sum, row) => sum + row.net, 0)
  if (order.netCents < owedNet) {
    await audit(q, order, 'billing.balance_short', {
      order: order.externalOrderId,
      paidCents: order.netCents,
      owedCents: owedNet,
      orders: open.map((row) => row.id),
    })
    return
  }
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
  await audit(q, order, 'billing.balance_settled', {
    order: order.externalOrderId,
    paidCents: order.netCents,
    owedCents: owedNet,
    orders: open.map((row) => row.id),
  })
}

function audit(q: Queryable, order: BillingOrder, action: string, data: Record<string, unknown>) {
  return q.insert(schema.auditLog).values({
    actor: 'system:billing',
    action,
    subjectType: 'account',
    subjectId: order.userId ?? '',
    data,
  })
}
