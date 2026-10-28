// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How often Polar is read for what doesn't change by the second, through the real Polar adapter
 * against a stand-in for Polar's API: the gifts on sale, listed once for every read in a few
 * minutes, and an account's standing, read again on request up to a number of times a minute.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { hasDatabase } from '../../testing/harness.ts'
import { failing, page, product } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import type { GiftProduct } from '../ports/optional.ts'
import { installTuning, tuning } from '../tuning.ts'

/** A one-time product that sells a month of Plus as a gift, as Polar lists it. */
const GIFT = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c0b1'
const MONTH: GiftProduct = { id: GIFT, planKey: 'plus', months: 1, priceCents: 1500 }
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

/** The tuning in force before any test here installs its own. */
const DEFAULTS = tuning()
afterEach(() => {
  installTuning(DEFAULTS)
  setSystemTime()
})

beforeEach(() => w.reset())

/** Polar lists the gift product when asked for gifts, or answers that it is down; else as it holds. */
const listsGifts = (answer: 'listed' | 'down') => {
  w.reset()
  const held = w.polar.reply
  w.polar.reply = (request) =>
    request.method === 'GET' && request.path.startsWith('/v1/products/?') && request.path.includes('gift')
      ? answer === 'down'
        ? failing()
        : { status: 200, body: page([giftProduct]) }
      : held(request)
}

/** How many times Polar was asked for the gift products. */
const giftListings = () =>
  w.polar.requests.filter((r) => r.path.startsWith('/v1/products/?') && r.path.includes('gift')).length

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string }) => error.code ?? '',
  )

test.skipIf(!hasDatabase)(
  'the gifts on sale are listed by Polar once for every read in five minutes',
  async () => {
    const gifts = w.h.app.billing.gifts
    // A listing that failed is not kept: the next read asks again.
    listsGifts('down')
    const before = giftListings()
    expect(await refusal(gifts.options())).toBe('billing_unavailable')
    listsGifts('listed')
    const reads = await Promise.all([gifts.options(), gifts.options(), gifts.options()])
    expect(reads).toEqual([[MONTH], [MONTH], [MONTH]])
    expect(await gifts.options()).toEqual([MONTH])
    expect(giftListings() - before).toBe(2)

    // Five minutes on, Polar is asked again.
    setSystemTime(new Date(Date.now() + 5 * MINUTE_MS))
    expect(await gifts.options()).toEqual([MONTH])
    expect(giftListings() - before).toBe(3)
  },
)

test.skipIf(!hasDatabase)(
  'an account’s standing is read again up to the minute’s limit, each account its own',
  async () => {
    const was = tuning()
    installTuning({ ...was, abuse: { ...was.abuse, refreshesPerMinute: 2 } })
    const { owner } = await w.subscriber('Ida')
    const { owner: other } = await w.subscriber('Jon')
    await w.h.app.billing.refresh(owner)
    await w.h.app.billing.refresh(owner)
    const asked = w.polar.requests.length
    expect(await refusal(w.h.app.billing.refresh(owner))).toBe('rate_limited')
    // Refused before Polar is asked.
    expect(w.polar.requests.length).toBe(asked)
    expect(await refusal(w.h.app.billing.refresh(other))).toBeNull()
  },
)
