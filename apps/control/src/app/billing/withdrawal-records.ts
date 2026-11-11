// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Purchases cancelled within their 14 days, as `billing_withdrawals` keeps them: whether an order
 * was, the one a request makes, and what an account asked for before. One row per order, so a
 * request made twice, or two at once, is kept once. It is not where a purchase is found or its
 * amount worked out (`withdrawable.ts`), nor what a request does (`withdrawals.ts`).
 */
import { type Queryable, schema } from '@blockly/db'
import { and, desc, eq, gt } from 'drizzle-orm'

const withdrawals = schema.billingWithdrawals

export type WithdrawalRecord = typeof withdrawals.$inferSelect

/**
 * The request kept for the order; null when nobody cancelled it from the account page. A refund
 * the provider reports for an order that has one ends nothing a second time (`years.ts`, `gifts.ts`,
 * `ending.ts`).
 */
export async function withdrawalOf(
  q: Queryable,
  provider: string,
  externalOrderId: string,
): Promise<WithdrawalRecord | null> {
  const [row] = await q
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.provider, provider), eq(withdrawals.externalOrderId, externalOrderId)))
  return row ?? null
}

/**
 * Keeps the request, once: false when the order has one already, which the caller refuses kindly.
 * Run in the transaction that stops the purchase, so neither happens without the other.
 */
export async function keepWithdrawal(q: Queryable, record: WithdrawalRecord): Promise<boolean> {
  const kept = await q.insert(withdrawals).values(record).onConflictDoNothing().returning({
    order: withdrawals.externalOrderId,
  })
  return kept.length > 0
}

/** What the account cancelled since `since`, newest first, for its page to say. */
export async function withdrawalsSince(q: Queryable, userId: string, since: Date) {
  return q
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.userId, userId), gt(withdrawals.requestedAt, since)))
    .orderBy(desc(withdrawals.requestedAt))
}
