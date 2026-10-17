// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A balance order settles what it names once, whatever order and however often Polar delivers it:
 * deliveries of it handled at the same moment clear the debt once and refund nothing it paid
 * for, and a refunded balance stays owed when an older paid delivery of it comes again.
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

/** A subscriber whose ended subscription left a renewal owed; answers the owner and that renewal. */
const owing = async (name: string) => {
  const { owner, sub } = await w.subscriber(name)
  await w.subscriptionNow(owner, sub, { status: 'canceled' })
  const renewal = await w.renewalWithExtra(owner, sub, new Date(), { status: 'void' })
  await w.h.app.billing.confirmOwed(anHourOn())
  return { owner, renewal }
}

test.skipIf(!hasDatabase)(
  'a paid balance delivered twice at once clears the debt once and refunds nothing',
  async () => {
    let refundedWhileCleared = 0
    const tries = 10
    for (let i = 0; i < tries; i++) {
      const { owner, renewal } = await owing(`Cy${i}`)
      const id = `order-${crypto.randomUUID()}`
      const held = order(owner.userId, {
        id,
        product_id: BALANCE,
        billing_reason: 'purchase',
        subscription_id: null,
        subtotal_amount: 1750,
        net_amount: 1750,
        tax_amount: 0,
        total_amount: 1750,
        metadata: { settles: renewal },
      })
      w.orders.set(id, held)
      const before = w.refunds.length
      // Polar's `order.paid` and `order.updated` for the same order, handled at the same moment.
      await Promise.all([w.post(orderEvent(held, 'order.paid')), w.post(orderEvent(held, 'order.updated'))])
      const owed = (await w.h.app.accountQueries.overview(owner)).usage.extra.owedCents
      if (owed === 0 && w.refunds.slice(before).some((r) => r.order_id === id)) refundedWhileCleared++
    }
    // Paid once, cleared once: no try both clears the debt and gives the money back.
    expect(refundedWhileCleared).toBe(0)
  },
  120_000,
)

test.skipIf(!hasDatabase)('a refunded balance stays owed when its paid delivery comes again', async () => {
  const { owner, renewal } = await owing('Rui')
  const balance = await w.paidBalance(owner, renewal, 1750)
  const paid = w.orders.get(balance) as NonNullable<ReturnType<typeof w.orders.get>>
  await w.post(orderEvent({ ...paid, status: 'refunded', refunded_amount: 1750 }, 'order.refunded'))
  expect((await w.h.app.accountQueries.overview(owner)).usage.extra).toMatchObject({ owedCents: 1750 })
  // Polar delivers the older `order.paid` again: the refund stands, and so does the debt.
  await w.post(orderEvent(paid, 'order.paid'))
  expect((await w.kept(balance))?.refundedCents).toBe(1750)
  expect((await w.h.app.accountQueries.overview(owner)).usage.extra).toMatchObject({ owedCents: 1750 })
})
