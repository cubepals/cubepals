// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A balance: what an account owes that the billing provider can no longer collect on its own (a
 * renewal carrying extra play whose subscription ended, which the provider voids), paid as a
 * one-time order of the provider's balance product (`settleUrl`), and that order's word clearing
 * the orders it names. Only an order for the balance product that covers what those orders came to,
 * before tax, clears them; anything else is kept on the account's audit log and the debt stays.
 * Whatever is paid twice, a balance for what was paid already or an order charged after a balance
 * cleared it, is answered as a refund to give back.
 *
 * It is not where an order becomes owed (`persistence.ts` `owing`) or where the block it puts on
 * servers is enforced (the policy).
 */
import { type Queryable, schema, type Tx } from '@blockly/db'
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
 * already stay cleared, and the provider's word again answers the same refund, which the caller
 * asks for only while it hasn't been (`claimRefund`). Refunded, so that less is
 * left of it than what it cleared, they are owed again.
 *
 * It reads the order as `recordOrder` kept it, under a lock on its row: deliveries of the same
 * order handled at once take turns, so what one cleared the next reads as cleared, and a delivery
 * older than a refund never clears the debt again.
 */
export async function settleWith(
  tx: Tx,
  provider: string,
  delivered: BillingOrder,
): Promise<{ refundCents: number }> {
  const none = { refundCents: 0 }
  const userId = delivered.userId
  if (!delivered.balance || userId === null || delivered.settles.length === 0) return none
  const [kept] = await tx
    .select({ status: orders.status, netCents: orders.netCents, refundedCents: orders.refundedCents })
    .from(orders)
    .where(and(eq(orders.provider, provider), eq(orders.externalOrderId, delivered.externalOrderId)))
    .for('update')
  if (kept === undefined) return none
  const order = { ...delivered, ...kept }
  if (order.refundedCents > 0) {
    await unsettle(tx, provider, order)
    return none
  }
  if (order.status !== 'paid') return none
  // Its own word again: what it cleared stays cleared, and what it paid past that is owed back
  // still, for a refund the provider didn't take the first time (`claimRefund` asks only once).
  const cleared = await clearedBy(tx, provider, order)
  if (cleared.length > 0)
    return { refundCents: order.netCents - cleared.reduce((sum, row) => sum + row.net, 0) }
  const named = await tx
    .select({ id: orders.externalOrderId, net: orders.netCents, settledBy: orders.settledBy })
    .from(orders)
    .where(
      and(
        eq(orders.provider, provider),
        eq(orders.userId, userId),
        inArray(orders.externalOrderId, order.settles),
        inArray(orders.status, UNPAID_ORDER),
      ),
    )
  const open = named.filter((row) => row.settledBy === null)
  const owedNet = open.reduce((sum, row) => sum + row.net, 0)
  const facts = { order: order.externalOrderId, paidCents: order.netCents, owedCents: owedNet }
  if (order.netCents < owedNet) {
    await audit(tx, order, 'billing.balance_short', { ...facts, orders: open.map((row) => row.id) })
    return none
  }
  // Still unpaid as it is cleared: one the provider charged meanwhile is left to its charge, and
  // what the balance paid for it is given back below, so it is never paid for twice (`paidTwice`).
  const settled =
    open.length === 0
      ? []
      : await tx
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
              inArray(orders.status, UNPAID_ORDER),
            ),
          )
          .returning({ id: orders.externalOrderId, net: orders.netCents })
  if (settled.length > 0)
    await audit(tx, order, 'billing.balance_settled', { ...facts, orders: settled.map((row) => row.id) })
  return { refundCents: order.netCents - settled.reduce((sum, row) => sum + row.net, 0) }
}

/**
 * An order a balance paid in its place (`settledBy`) that the provider charged after all, a final
 * charge still pending when it was owed: paid for twice. The balance stands, and what the charge
 * paid, before tax, is answered as `refundCents`, to be given back on the order itself (the caller
 * asks once, `claimRefund`). Nothing for any other order.
 */
export async function paidTwice(
  q: Queryable,
  provider: string,
  order: BillingOrder,
): Promise<{ refundCents: number; settledBy: string | null }> {
  const none = { refundCents: 0, settledBy: null }
  if (order.balance || order.status !== 'paid') return none
  const [row] = await q
    .select({ settledBy: orders.settledBy, refunded: orders.refundedCents })
    .from(orders)
    .where(and(eq(orders.provider, provider), eq(orders.externalOrderId, order.externalOrderId)))
  if (row === undefined || row.settledBy === null) return none
  return { refundCents: order.netCents - row.refunded, settledBy: row.settledBy }
}

/**
 * A balance order refunded: when what is left of it no longer covers the orders it cleared, they
 * are owed again, as they were.
 */
async function unsettle(q: Queryable, provider: string, order: BillingOrder): Promise<void> {
  const cleared = await clearedBy(q, provider, order)
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

/** The orders a balance order cleared, whatever has become of them since. */
const clearedBy = (q: Queryable, provider: string, order: BillingOrder) =>
  q
    .select({ id: orders.externalOrderId, net: orders.netCents })
    .from(orders)
    .where(and(eq(orders.provider, provider), eq(orders.settledBy, order.externalOrderId)))

/**
 * Claims the refund of an order for this caller, once: false when it was asked for already,
 * so a webhook delivered twice never refunds twice. One the provider didn't take is given back
 * (`releaseRefund`), for the provider's next delivery to try again.
 */
export async function claimRefund(q: Queryable, provider: string, externalOrderId: string): Promise<boolean> {
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
  return claimed.length > 0
}

/** A refund claimed (`claimRefund`) that the provider didn't take, to be asked for again. */
export const releaseRefund = (q: Queryable, provider: string, externalOrderId: string) =>
  q
    .update(orders)
    .set({ refundAskedAt: null })
    .where(and(eq(orders.provider, provider), eq(orders.externalOrderId, externalOrderId)))

/** A balance paid past what was owed was refunded: kept on the account's audit log. */
export const auditRefund = (q: Queryable, order: BillingOrder, cents: number) =>
  audit(q, order, 'billing.balance_overpaid_refunded', {
    order: order.externalOrderId,
    refundCents: cents,
    orders: order.settles,
  })

/** An order a balance had paid, charged as well, was refunded: kept on the account's audit log. */
export const auditPaidTwice = (q: Queryable, order: BillingOrder, balance: string, cents: number) =>
  audit(q, order, 'billing.paid_twice_refunded', {
    order: order.externalOrderId,
    balance,
    refundCents: cents,
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
