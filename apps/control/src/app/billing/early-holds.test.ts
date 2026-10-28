// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The price a checkout will charge, held while its page is open: an early price while the room
 * takes one more checkout of the plan, the plan's own otherwise; holds that never take more than
 * the room, however many open at once; a hold kept on reopening, let go for a year or another plan,
 * returned when it runs out; and the same choice for a plan bought over a smaller one, a move to a
 * smaller one, and a subscription on its plan's own price taking the early one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { TERMS_VERSION } from '@blockly/contracts'
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import { CORE_PRODUCT, earlyProduct, PLUS_PRODUCT, subscription } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { EarlyRoomControl } from './early-room.ts'

const EARLY_CORE = '4f1e2d3c-5b6a-4978-8c9d-0a1b2c3d4e01'
const EARLY_PLUS = '4f1e2d3c-5b6a-4978-8c9d-0a1b2c3d4f01'
const CONSENT = { consent: { terms: TERMS_VERSION, startNow: true } } as const

const w = new PolarWorld()
let room: EarlyRoomControl

beforeAll(async () => {
  if (!hasDatabase) return
  await w.start()
  room = new EarlyRoomControl({ db: w.h.db, maxPoints: 100_000 })
}, 30_000)
afterAll(async () => {
  if (hasDatabase) await w.close()
})
beforeEach(async () => {
  if (!hasDatabase) return
  w.reset()
  w.early.splice(
    0,
    w.early.length,
    earlyProduct(EARLY_CORE, { plan: 'core', included_units: 90, most_extra_units: 12 }, 700),
    earlyProduct(EARLY_PLUS, { plan: 'plus', included_units: 160 }, 1200),
  )
  await w.h.db.delete(schema.earlyHolds)
  await open(0)
})

/** Room for `checkouts` of Core, at 100 points each, and Plus at 300, from figures read at `readAt`. */
const open = (checkouts: number, readAt?: Date) =>
  room.set({
    roomPoints: checkouts * 100,
    points: { core: 100, plus: 300 },
    validUntil: new Date(Date.now() + 30 * MINUTE_MS),
    readAt,
  })
const lastCheckout = () => [...w.checkouts.values()].at(-1)?.asked

describe.skipIf(!hasDatabase)('the price a checkout holds', () => {
  test('with no room, a month is the plan’s own price, sold on its own product with a code allowed', async () => {
    const owner = await w.h.user('Closed')
    expect(await w.h.app.billing.offer(owner, 'core')).toMatchObject({ priceCents: 999, productId: null })
    await w.h.app.billing.startCheckout(owner, 'core', { ...CONSENT, priceCents: 999 })
    expect(lastCheckout()).toMatchObject({ products: [CORE_PRODUCT], allow_discount_codes: true })
  })

  test('with room, the early price is held and sold on its product, with no code', async () => {
    await open(1)
    const owner = await w.h.user('Early')
    expect(await w.h.app.billing.offer(owner, 'core')).toMatchObject({
      priceCents: 700,
      includedUnits: 90,
      productId: EARLY_CORE,
    })
    await w.h.app.billing.startCheckout(owner, 'core', { ...CONSENT, priceCents: 700 })
    expect(lastCheckout()).toMatchObject({ products: [EARLY_CORE], allow_discount_codes: false })
    // The room took one checkout: the next person is offered the plan's own price.
    const next = await w.h.user('Next')
    expect((await w.h.app.billing.offer(next, 'core')).productId).toBeNull()
  })

  test('reopening keeps the hold; another plan or a year lets it go', async () => {
    await open(3)
    const owner = await w.h.user('Again')
    await w.h.app.billing.offer(owner, 'core')
    await w.h.app.billing.offer(owner, 'core')
    expect(await w.h.db.select().from(schema.earlyHolds)).toHaveLength(1)
    // Plus takes 300 points, all there is once Core's hold is let go.
    expect((await w.h.app.billing.offer(owner, 'plus')).productId).toBe(EARLY_PLUS)
    expect((await w.h.db.select().from(schema.earlyHolds))[0]?.planKey).toBe('plus')
    await w.h.app.billing.startCheckout(owner, 'plus', { ...CONSENT, term: 'year' }).catch(() => undefined)
    expect(await w.h.db.select().from(schema.earlyHolds)).toHaveLength(0)
  })

  test('many checkouts at once never hold more than the room', async () => {
    await open(3)
    const owners = await Promise.all(Array.from({ length: 10 }, (_, i) => w.h.user(`Rush${i}`)))
    const offers = await Promise.all(owners.map((owner) => w.h.app.billing.offer(owner, 'core')))
    expect(offers.filter((offer) => offer.productId === EARLY_CORE)).toHaveLength(3)
    expect(await w.h.db.select().from(schema.earlyHolds)).toHaveLength(3)
  })

  test('a hold that runs out unpaid gives its room back', async () => {
    await open(1)
    await w.h.app.billing.offer(await w.h.user('Left'), 'core')
    const later = await w.h.user('Later')
    expect((await w.h.app.billing.offer(later, 'core')).productId).toBeNull()
    setSystemTime(new Date(Date.now() + 61 * MINUTE_MS))
    try {
      await open(1)
      expect((await w.h.app.billing.offer(later, 'core')).productId).toBe(EARLY_CORE)
    } finally {
      setSystemTime()
    }
  })

  test('a paid hold counts until the room is set again after the payment', async () => {
    await open(1)
    const owner = await w.h.user('Paid')
    await w.h.app.billing.offer(owner, 'core')
    await w.standing(owner, randomUUID(), { product_id: EARLY_CORE })
    const [hold] = await w.h.db
      .select()
      .from(schema.earlyHolds)
      .where(eq(schema.earlyHolds.userId, owner.userId))
    expect(hold?.paidAt).not.toBeNull()
    expect((await loadStanding(w.h.db, owner.userId)).soldWith?.includedUnits).toBe(90)
    const other = await w.h.user('Other')
    expect((await w.h.app.billing.offer(other, 'core')).productId).toBeNull()
    // Set again, the room counts the subscription itself: the paid hold no longer does.
    await open(1)
    expect((await w.h.app.billing.offer(other, 'core')).productId).toBe(EARLY_CORE)
  })

  test('a hold paid late in its hour still counts after it, until figures read after the payment', async () => {
    const start = Date.now()
    try {
      await open(1)
      const owner = await w.h.user('Late payer')
      await w.h.app.billing.offer(owner, 'core')
      setSystemTime(new Date(start + 50 * MINUTE_MS))
      await w.standing(owner, randomUUID(), { product_id: EARLY_CORE })
      setSystemTime(new Date(start + 61 * MINUTE_MS))
      // Set again from figures read before the payment: they don't count it, so the hold still does.
      await open(1, new Date(start + 49 * MINUTE_MS))
      const next = await w.h.user('Next')
      expect((await w.h.app.billing.offer(next, 'core')).productId).toBeNull()
      await open(1, new Date(start + 60 * MINUTE_MS))
      expect((await w.h.app.billing.offer(next, 'core')).productId).toBe(EARLY_CORE)
    } finally {
      setSystemTime()
    }
  })

  test('a paid hold stays when its owner opens another plan or a year, while the room counts it', async () => {
    await open(3)
    const owner = await w.h.user('Paid Core')
    await w.h.app.billing.offer(owner, 'core')
    await w.standing(owner, randomUUID(), { product_id: EARLY_CORE })
    expect((await w.h.app.billing.offer(owner, 'plus')).productId).toBeNull()
    await w.h.app.billing.startCheckout(owner, 'core', { ...CONSENT, term: 'year' }).catch(() => undefined)
    const [hold] = await w.h.db
      .select()
      .from(schema.earlyHolds)
      .where(eq(schema.earlyHolds.userId, owner.userId))
    expect(hold?.paidAt).not.toBeNull()
    // Set again, the room counts the subscription: the paid hold can make way for a new one.
    await open(3)
    expect((await w.h.app.billing.offer(owner, 'plus')).productId).toBe(EARLY_PLUS)
  })

  test('a checkout at a price the page no longer shows is refused before any payment', async () => {
    await open(1)
    const owner = await w.h.user('Stale')
    await expect(
      w.h.app.billing.startCheckout(owner, 'core', { ...CONSENT, priceCents: 999 }),
    ).rejects.toThrow(/\$7\.00 a month now/)
    expect(lastCheckout()?.external_customer_id).not.toBe(owner.userId)
  })
})

describe.skipIf(!hasDatabase)('plan changes at the held price', () => {
  test('Plus bought over Core takes the early Plus where there is room, and Plus’s own where not', async () => {
    const owner = await w.h.user('Upgrade')
    const sub = randomUUID()
    await w.standing(owner, sub, { product_id: CORE_PRODUCT })
    await open(3)
    await w.h.app.billing.offer(owner, 'plus')
    await w.h.app.billing.startCheckout(owner, 'plus', { ...CONSENT, priceCents: 1200 })
    expect(w.updates.at(-1)).toMatchObject({
      id: sub,
      body: { product_id: EARLY_PLUS, proration_behavior: 'invoice' },
    })

    const regular = await w.h.user('UpgradeOwn')
    const own = randomUUID()
    await w.standing(regular, own, { product_id: CORE_PRODUCT })
    await open(0)
    await w.h.app.billing.startCheckout(regular, 'plus', { ...CONSENT, priceCents: 2500 })
    expect(w.updates.at(-1)).toMatchObject({ id: own, body: { product_id: PLUS_PRODUCT } })
  })

  test('a move down to Core shows its price first and takes the early Core where there is room', async () => {
    const owner = await w.h.user('Down')
    const sub = randomUUID()
    await w.standing(owner, sub, { product_id: PLUS_PRODUCT })
    // Its month ends in three weeks, when Polar applies the move.
    const periodEnd = new Date(Date.now() + 21 * DAY_MS).toISOString()
    w.subscriptions.set(
      sub,
      subscription(sub, { status: 'active', ended_at: null, current_period_end: periodEnd }),
    )
    await open(1)
    const offer = await w.h.app.billing.offer(owner, 'core')
    expect(offer.priceCents).toBe(700)
    await w.h.app.billing.moveToSmaller(owner, 'core', offer.priceCents)
    expect(w.updates.at(-1)).toMatchObject({
      id: sub,
      body: { product_id: EARLY_CORE, proration_behavior: 'next_period' },
    })
    // The move applies at the month's end: its room stays taken past the hour and a new setting.
    setSystemTime(new Date(Date.now() + 61 * MINUTE_MS))
    try {
      await open(1)
      const next = await w.h.user('After the move')
      expect((await w.h.app.billing.offer(next, 'core')).productId).toBeNull()
    } finally {
      setSystemTime()
    }
  })

  test('a move down that is refused lets its hold go', async () => {
    const owner = await w.h.user('No plan')
    await open(1)
    const offer = await w.h.app.billing.offer(owner, 'core')
    await expect(w.h.app.billing.moveToSmaller(owner, 'core', offer.priceCents)).rejects.toThrow(
      'no plan paid by the month',
    )
    const next = await w.h.user('Next in line')
    expect((await w.h.app.billing.offer(next, 'core')).productId).toBe(EARLY_CORE)
  })

  test('a switch at a price no longer open lets its hold go', async () => {
    const owner = await w.h.user('Switch late')
    await w.standing(owner, randomUUID(), { product_id: CORE_PRODUCT })
    await open(1)
    await expect(w.h.app.billing.switchPrice(owner, 650)).rejects.toThrow('isn’t open any more')
    const next = await w.h.user('Switch next')
    expect((await w.h.app.billing.offer(next, 'core')).productId).toBe(EARLY_CORE)
  })

  test('a subscription on its plan’s own price can take the early price now, and only through the room', async () => {
    const owner = await w.h.user('Switch')
    const sub = randomUUID()
    await w.standing(owner, sub, { product_id: CORE_PRODUCT })
    expect(await w.h.app.billing.switchable(owner)).toBeNull()
    await open(1)
    expect(await w.h.app.billing.switchable(owner)).toMatchObject({ priceCents: 700, productId: EARLY_CORE })
    await w.h.app.billing.switchPrice(owner, 700)
    expect(w.updates.at(-1)).toMatchObject({ id: sub, body: { product_id: EARLY_CORE } })
    expect((await loadStanding(w.h.db, owner.userId)).soldWith).toMatchObject({
      priceCents: 700,
      includedUnits: 90,
    })
    expect(await w.h.app.billing.switchable(owner)).toBeNull()
  })
})
