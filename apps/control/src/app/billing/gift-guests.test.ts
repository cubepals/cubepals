// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gifts made before their checkout (GIFTS_BY_EMAIL), through Polar's signed webhooks: a guest's
 * checkout names the gift and no customer, its paid order is kept with no account and pays for
 * the gift it names, whatever account Polar filed it under; a refund that comes first is the
 * gift's by its id too. An order naming a gift this deployment never made, or a guest's with the
 * setting off, is not kept.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { hasDatabase } from '../../testing/harness.ts'
import { customer, order, orderEvent, product } from '../../testing/polar.ts'
import { PolarWorld } from '../../testing/polar-world.ts'
import type { GiftProduct } from '../ports/optional.ts'
import { installTuning, tuning } from '../tuning.ts'

/** A one-time product that sells a month of Plus as a gift, as Polar holds it. */
const GIFT = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c0a1'
type PolarOrder = ReturnType<typeof order>
const MONTH: GiftProduct = { id: GIFT, planKey: 'plus', months: 1, priceCents: 1500 }
const giftProduct = product(GIFT, {
  name: 'Plus, a month as a gift',
  metadata: { purpose: 'gift', plan: 'plus', months: 1 },
  prices: [{ amount_type: 'fixed', price_amount: 1500, price_currency: 'usd', is_archived: false } as never],
})

/** Polar answers for the gift product, and from what it holds for anything else. */
const sellsGift = (w: PolarWorld) => {
  w.reset()
  const answer = w.polar.reply
  w.polar.reply = (request) =>
    request.method === 'GET' && request.path.startsWith(`/v1/products/${GIFT}`)
      ? { status: 200, body: giftProduct }
      : answer(request)
}

/** A gift a guest started, made before its checkout as the gift page makes it. */
const started = async (w: PolarWorld, patch: Partial<typeof schema.planGifts.$inferInsert> = {}) => {
  const [row] = await w.h.db
    .insert(schema.planGifts)
    .values({
      provider: 'polar',
      buyerEmail: 'guest@example.test',
      recipientEmail: 'friend@example.test',
      recipientKey: `recipient-${randomUUID()}`,
      delivery: 'email',
      state: 'checkout',
      planKey: 'plus',
      months: 1,
      ...patch,
    })
    .returning()
  if (!row) throw new Error('no gift was made')
  return row
}

/** Polar's word on a gift's order: paid for by `payer` (no account of ours unless it has one), unless patched. */
const delivered = async (
  w: PolarWorld,
  giftId: string,
  payer: { externalId: string | null; email: string },
  patch: Partial<PolarOrder> = {},
  type: 'order.paid' | 'order.refunded' = 'order.paid',
) => {
  const id = patch.id ?? `order-gift-${randomUUID()}`
  const held = order(null, {
    product_id: GIFT,
    billing_reason: 'purchase',
    subscription_id: null,
    metadata: { purpose: 'gift', gift: giftId },
    customer: { ...customer(payer.externalId), email: payer.email },
    ...patch,
    id,
  })
  w.orders.set(id, held)
  await w.post(orderEvent(held, type))
  return id
}

const gift = async (w: PolarWorld, id: string) => {
  const [row] = await w.h.db.select().from(schema.planGifts).where(eq(schema.planGifts.id, id))
  return row
}

const auditedFor = async (w: PolarWorld, subjectType: string, subjectId: string) =>
  (
    await w.h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, subjectType), eq(schema.auditLog.subjectId, subjectId)))
  ).map((row) => row.action)

const GUEST = { externalId: null, email: 'guest@example.test' }

describe.skipIf(!hasDatabase)('with GIFTS_BY_EMAIL', () => {
  const w = new PolarWorld()
  const before = tuning()

  beforeAll(() => w.start(), 30_000)
  afterAll(() => w.close())
  beforeEach(() => {
    sellsGift(w)
    installTuning({ ...before, giftsByEmail: true })
  })
  afterEach(() => installTuning(before))

  test('a guest’s checkout names the gift and no customer, and is offered again while it is open', async () => {
    const billing = w.billing
    if (billing === null) throw new Error('PolarWorld is not started')
    const giftId = randomUUID()
    const ask = () =>
      billing.giftCheckoutUrl({
        userId: null,
        email: 'guest@example.test',
        gift: MONTH,
        giftId,
        returnUrl: 'http://localhost:3000/gift',
      })
    const url = await ask()
    expect(await ask()).toBe(url)
    const made = [...w.checkouts.values()].filter((c) => c.made.metadata.gift === giftId)
    expect(made).toHaveLength(1)
    expect(made[0]?.asked).toMatchObject({
      products: [GIFT],
      customer_email: 'guest@example.test',
      metadata: { purpose: 'gift', gift: giftId },
    })
    expect(made[0]?.asked.external_customer_id).toBeUndefined()
  })

  test('a guest’s paid order is kept with no account, and pays for the gift it names, once', async () => {
    const row = await started(w)
    const id = await delivered(w, row.id, GUEST)
    await w.post(orderEvent(w.orders.get(id) as PolarOrder, 'order.paid'))
    expect(await w.kept(id)).toMatchObject({ userId: null, giftId: row.id, status: 'paid' })
    expect(await gift(w, row.id)).toMatchObject({
      state: 'paid',
      externalOrderId: id,
      buyerId: null,
      buyerEmail: 'guest@example.test',
      recipientEmail: 'friend@example.test',
      codeHash: null,
    })
    expect(await auditedFor(w, 'gift', row.id)).toEqual(['billing.gift_bought'])
    // Its delivery by email is a step of its own: nothing is sent yet.
    expect(w.h.mail.to('guest@example.test')).toHaveLength(0)
    expect(w.h.mail.to('friend@example.test')).toHaveLength(0)
  })

  test('filed by Polar under the account with the guest’s email, it is still the guest’s', async () => {
    const account = await w.h.user('Ebba')
    const [user] = await w.h.db.select().from(schema.users).where(eq(schema.users.id, account.userId))
    const row = await started(w, { buyerEmail: user?.email ?? '' })
    const id = await delivered(w, row.id, { externalId: account.userId, email: user?.email ?? '' })
    expect(await w.kept(id)).toMatchObject({ userId: null, giftId: row.id })
    expect(await gift(w, row.id)).toMatchObject({ state: 'paid', buyerId: null })
    expect(await auditedFor(w, 'account', account.userId)).toEqual([])
    expect(await w.mailTo(account)).toHaveLength(0)
  })

  test('refunded before its paid delivery, the gift it names is refunded and forgets who it was for', async () => {
    const row = await started(w)
    const id = await delivered(
      w,
      row.id,
      GUEST,
      { status: 'refunded', refunded_amount: 1500 },
      'order.refunded',
    )
    await w.post(
      orderEvent({ ...(w.orders.get(id) as PolarOrder), status: 'paid', refunded_amount: 0 }, 'order.paid'),
    )
    expect((await w.kept(id))?.refundedCents).toBe(1500)
    const after = await gift(w, row.id)
    expect(after).toMatchObject({ state: 'refunded', externalOrderId: id, recipientEmail: null })
    expect(after?.voidedAt).not.toBeNull()
    expect(after?.recipientKey).toBe(row.recipientKey)
    expect(await auditedFor(w, 'gift', row.id)).toEqual(['billing.gift_refunded'])
  })

  test('an order naming a gift this deployment never made is not its order', async () => {
    const id = await delivered(w, randomUUID(), GUEST)
    expect(await w.kept(id)).toBeUndefined()
  })

  test('an account’s gift made before its checkout is found by its id, and its code emailed', async () => {
    const buyer = await w.h.user('Pia')
    const row = await started(w, {
      buyerId: buyer.userId,
      buyerEmail: null,
      delivery: 'code',
      recipientKey: null,
    })
    const id = await delivered(w, row.id, { externalId: buyer.userId, email: 'pia@example.test' })
    expect(await w.kept(id)).toMatchObject({ userId: buyer.userId, giftId: row.id })
    expect(await gift(w, row.id)).toMatchObject({ state: 'paid', buyerEmail: 'pia@example.test' })
    expect((await gift(w, row.id))?.codeHash).not.toBeNull()
    expect((await w.mailTo(buyer)).at(-1)?.text).toMatch(/[0-9A-Z]{4}(-[0-9A-Z]{4}){3}/)
    expect(await w.h.app.billing.gifts.mine(buyer)).toMatchObject([{ id: row.id, state: 'waiting' }])
  })
})

describe.skipIf(!hasDatabase)('a gift made before its checkout, not paid for', () => {
  const w = new PolarWorld()

  beforeAll(() => w.start(), 30_000)
  afterAll(() => w.close())

  test('has no code to send again, and one delivered by email never has', async () => {
    const buyer = await w.h.user('Ida')
    const unpaid = await started(w, {
      buyerId: buyer.userId,
      buyerEmail: null,
      delivery: 'code',
      recipientKey: null,
    })
    await expect(w.h.app.billing.gifts.resend(buyer, unpaid.id)).rejects.toThrow(/not found/i)
    const emailed = await started(w, {
      buyerId: buyer.userId,
      state: 'paid',
      externalOrderId: `order-${randomUUID()}`,
    })
    await expect(w.h.app.billing.gifts.resend(buyer, emailed.id)).rejects.toThrow(/no code to send/)
    expect((await gift(w, unpaid.id))?.codeHash).toBeNull()
    expect((await gift(w, emailed.id))?.codeHash).toBeNull()
  })
})

describe.skipIf(!hasDatabase)('without GIFTS_BY_EMAIL', () => {
  const w = new PolarWorld()

  beforeAll(() => w.start(), 30_000)
  afterAll(() => w.close())
  beforeEach(() => sellsGift(w))

  test('a guest’s order is not kept, and the gift it names waits unpaid', async () => {
    const row = await started(w)
    const id = await delivered(w, row.id, GUEST)
    expect(await w.kept(id)).toBeUndefined()
    expect(await gift(w, row.id)).toMatchObject({ state: 'checkout', externalOrderId: null })
  })
})
