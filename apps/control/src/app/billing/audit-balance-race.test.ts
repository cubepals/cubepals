// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Polar sends `order.paid` and `order.updated` for the same order moments apart, and a delivery
 * can come twice. Two deliveries of one paid balance handled at once each read the debt before
 * either clears it (`settleWith` runs outside a transaction): one clears it, the other finds
 * nothing left to clear and answers the whole balance as overpaid, which is refunded.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { hasDatabase } from '../../testing/harness.ts'
import { order, orderEvent } from '../../testing/polar.ts'
import { BALANCE, PolarWorld } from '../../testing/polar-world.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

const anHourOn = () => new Date(Date.now() + 61 * MINUTE_MS)

test.skipIf(!hasDatabase)(
  'a balance delivered twice at once clears the debt and refunds nothing',
  async () => {
    let refundedWhileCleared = 0
    const tries = 10
    for (let i = 0; i < tries; i++) {
      const { owner, sub } = await w.subscriber(`Cy${i}`)
      await w.subscriptionNow(owner, sub, { status: 'canceled' })
      const renewal = await w.renewalWithExtra(owner, sub, new Date(), { status: 'void' })
      await w.h.app.billing.confirmOwed(anHourOn())
      const id = `order-${crypto.randomUUID()}`
      const balance = {
        id,
        product_id: BALANCE,
        billing_reason: 'purchase',
        subscription_id: null,
        subtotal_amount: 1750,
        net_amount: 1750,
        tax_amount: 0,
        total_amount: 1750,
        metadata: { settles: renewal },
      } as const
      const held = order(owner.userId, balance)
      w.orders.set(id, held)
      const before = w.refunds.length
      await Promise.all([w.post(orderEvent(held, 'order.paid')), w.post(orderEvent(held, 'order.updated'))])
      const owed = (await w.h.app.accountQueries.overview(owner)).usage.extra.owedCents
      if (owed === 0 && w.refunds.slice(before).some((r) => r.order_id === id)) refundedWhileCleared++
    }
    // Paid once, cleared once: no try may both clear the debt and give the money back.
    expect(refundedWhileCleared).toBe(0)
  },
  120_000,
)
