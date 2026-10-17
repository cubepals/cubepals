// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A gift never runs under days a subscription is paid for: when Plus renews over a redeemed gift,
 * the gift moves to start when the paid time ends. One that hasn't started keeps its months; one
 * running keeps the time it had left.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import type { UserActor } from '../actor.ts'
import { codeHash, codeHint, newCode } from './gift-codes.ts'
import { addMonths } from './years.ts'

const w = new PolarWorld()

beforeAll(async () => {
  if (hasDatabase) await w.start()
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await w.close()
})

beforeEach(() => w.reset())

const giftOf = async (owner: UserActor) => {
  const [gift] = await w.h.db
    .select()
    .from(schema.planGifts)
    .where(eq(schema.planGifts.redeemedBy, owner.userId))
  return gift
}

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
    // The gift starts when the paid month ends, its month whole, and the account page says so.
    const gift = await giftOf(owner)
    expect(gift?.startsAt).toEqual(renewedEnd)
    expect(gift?.endsAt).toEqual(addMonths(renewedEnd, 1))
    expect((await w.h.app.accountQueries.overview(owner)).plan.giftNext).toEqual({
      planKey: 'plus',
      months: 1,
      startsAt: renewedEnd,
      endsAt: expect.any(Date),
      continues: false,
    })
    expect(await w.audited(owner, 'billing.gift_moved')).toHaveLength(1)
  },
)

test.skipIf(!hasDatabase)('a running gift keeps the time it had left when Plus renews over it', async () => {
  const owner = await w.h.user('Yui')
  const buyer = await w.h.user('Zed')
  const now = Date.now()
  const left = 25 * DAY_MS
  // Five days into a gifted month, with the rest of it still to run.
  await w.h.db.insert(schema.planGifts).values({
    provider: 'polar',
    externalOrderId: `gift-${crypto.randomUUID()}`,
    buyerId: buyer.userId,
    planKey: 'plus',
    months: 1,
    emailedAt: new Date(now - 6 * DAY_MS),
    redeemedBy: owner.userId,
    redeemedAt: new Date(now - 5 * DAY_MS),
    startsAt: new Date(now - 5 * DAY_MS),
    endsAt: new Date(now + left),
  })
  // A subscription to Plus starts, and renews.
  const periodEnd = new Date(now + 30 * DAY_MS)
  await w.standing(owner, crypto.randomUUID(), {
    current_period_end: periodEnd.toISOString(),
    cancel_at_period_end: false,
  })
  const gift = await giftOf(owner)
  expect(gift?.startsAt).toEqual(periodEnd)
  // The time it had left when it moved, give or take the moment the sync took.
  const kept = (gift?.endsAt?.getTime() ?? 0) - periodEnd.getTime()
  expect(kept).toBeLessThanOrEqual(left)
  expect(kept).toBeGreaterThan(left - MINUTE_MS)
  // The account page says what is left of it continues then, not that a whole month starts.
  expect((await w.h.app.accountQueries.overview(owner)).plan.giftNext).toMatchObject({
    startsAt: periodEnd,
    continues: true,
  })
})
