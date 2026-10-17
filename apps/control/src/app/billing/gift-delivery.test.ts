// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A gift is made only for an order Blockly keeps as paid and not refunded, whatever order Polar
 * delivers its word in: one refunded before its paid delivery is handled never gets a code.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import { orderEvent, product } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'

/** A one-time product that sells a month of Plus as a gift, as Polar holds it. */
const GIFT = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c0a1'
const giftProduct = product(GIFT, {
  name: 'Plus, a month as a gift',
  metadata: { purpose: 'gift', plan: 'plus', months: 1 },
  prices: [{ amount_type: 'fixed', price_amount: 1500, price_currency: 'usd', is_archived: false } as never],
})

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => {
  w.reset()
  const answer = w.polar.reply
  w.polar.reply = (request) =>
    request.method === 'GET' && request.path.startsWith(`/v1/products/${GIFT}`)
      ? { status: 200, body: giftProduct }
      : answer(request)
})

test.skipIf(!hasDatabase)('a gift refunded before its paid delivery arrives never gets a code', async () => {
  const buyer = await w.h.user('Pia')
  const id = `order-gift-${crypto.randomUUID()}`
  const paid = {
    id,
    product_id: GIFT,
    billing_reason: 'purchase',
    subscription_id: null,
  } as const
  // The refund's word is handled first, and the paid delivery after it.
  await w.ordered(buyer, null, { ...paid, status: 'refunded', refunded_amount: 1500 }, 'order.refunded')
  await w.post(
    orderEvent(
      {
        ...(w.orders.get(id) as NonNullable<ReturnType<typeof w.orders.get>>),
        status: 'paid',
        refunded_amount: 0,
      },
      'order.paid',
    ),
  )
  // Blockly keeps the order as refunded…
  expect((await w.kept(id))?.refundedCents).toBe(1500)
  // …so the gift is kept as refunded, with no code, and nothing is emailed.
  const [gift] = await w.h.db
    .select()
    .from(schema.planGifts)
    .where(eq(schema.planGifts.buyerId, buyer.userId))
  expect(gift === undefined || gift.voidedAt !== null).toBe(true)
  expect(gift?.codeHash ?? null).toBeNull()
  expect((await w.mailTo(buyer)).length).toBe(0)
})
