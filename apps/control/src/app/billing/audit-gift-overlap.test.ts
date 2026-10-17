// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A gift redeemed while Plus is set to end starts when the paid time ends, as the redeem page
 * says. If the owner then keeps Plus in Polar's portal, the subscription renews over the gift's
 * dates: the owner pays for months the gift was meant to cover, and the gift runs out unused.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { codeHash, codeHint, newCode } from './gift-codes.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

test.skipIf(!hasDatabase)(
  'a gift never runs under a subscription that is paid for the same days',
  async () => {
    const { owner, sub } = await w.subscriber('Wen')
    const periodEnd = new Date(Date.now() + 20 * DAY_MS)
    // Set to end at the period's end, as the redeem page asks.
    await w.standing(owner, sub, {
      current_period_end: periodEnd.toISOString(),
      cancel_at_period_end: true,
      canceled_at: new Date().toISOString(),
    })
    const buyer = await w.h.user('Xia')
    const code = newCode()
    await w.h.db.insert(schema.planGifts).values({
      provider: 'polar',
      externalOrderId: `gift-${crypto.randomUUID()}`,
      buyerId: buyer.userId,
      planKey: 'plus',
      months: 1,
      codeHash: codeHash(code),
      codeHint: codeHint(code),
      emailedAt: new Date(),
    })
    const redeemed = await w.h.app.billing.gifts.redeem(owner, code)
    expect(new Date(redeemed.startsAt)).toEqual(periodEnd)
    // The owner keeps Plus in the portal, and it renews for another month.
    const renewedEnd = new Date(periodEnd.getTime() + 30 * DAY_MS)
    await w.standing(owner, sub, {
      current_period_end: renewedEnd.toISOString(),
      cancel_at_period_end: false,
    })
    const [gift] = await w.h.db
      .select()
      .from(schema.planGifts)
      .where(eq(schema.planGifts.redeemedBy, owner.userId))
    // The gift's month still sits under the renewed, paid month.
    expect(gift?.startsAt?.getTime() ?? 0).toBeGreaterThanOrEqual(renewedEnd.getTime())
  },
)
