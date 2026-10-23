// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gifts in Polar's terms: a gift product read back as one, a gift checkout's customer and
 * metadata, and the gift and payer read from its order, as the sandbox delivered one.
 */
import { expect, test } from 'bun:test'
import { giftCheckoutOf, giftOf, giftOrderOf } from './polar-gifts.ts'

const PLANS = new Set(['plus'])

/** The gift product as the sandbox holds it (read 2026-10-12), with the fields `giftOf` reads. */
const product = (patch: Record<string, unknown> = {}) => ({
  id: '3fef3123-591e-4723-95e7-b19e4157f6cc',
  is_recurring: false,
  is_archived: false,
  metadata: { purpose: 'gift', plan: 'plus', months: 1 },
  prices: [
    { amount_type: 'fixed', type: 'one_time', is_archived: false, price_amount: 1500, price_currency: 'usd' },
  ],
  ...patch,
})

test('a one-time product marked as a gift for a plan sold here is a gift', () => {
  expect(giftOf(product(), PLANS)).toEqual({
    id: '3fef3123-591e-4723-95e7-b19e4157f6cc',
    planKey: 'plus',
    months: 1,
    priceCents: 1500,
  })
  expect(giftOf(product({ metadata: { purpose: 'gift', plan: 'plus', months: '12' } }), PLANS)?.months).toBe(
    12,
  )
})

test('anything else is not one', () => {
  expect(giftOf(product({ is_recurring: true }), PLANS)).toBeNull()
  expect(giftOf(product({ metadata: { purpose: 'balance' } }), PLANS)).toBeNull()
  expect(giftOf(product({ metadata: { purpose: 'gift', plan: 'pro', months: 1 } }), PLANS)).toBeNull()
  expect(giftOf(product({ metadata: { purpose: 'gift', plan: 'plus', months: 0.5 } }), PLANS)).toBeNull()
  expect(giftOf(product({ prices: [{ amount_type: 'custom' }] }), PLANS)).toBeNull()
  expect(giftOf({ id: 'x' }, PLANS)).toBeNull()
})

test('an account’s gift checkout names its customer; a guest’s names only the gift, made first', () => {
  const gift = '1bbb5840-195a-4e9c-87df-65b0760d7f41'
  expect(giftCheckoutOf({ userId: 'user_123', giftId: null })).toEqual({
    customer: { external_customer_id: 'user_123' },
    metadata: undefined,
  })
  expect(giftCheckoutOf({ userId: null, giftId: gift })).toEqual({
    customer: {},
    metadata: { purpose: 'gift', gift },
  })
  expect(() => giftCheckoutOf({ userId: null, giftId: null })).toThrow(/made before its checkout/)
})

/**
 * A guest's gift order, with the fields `giftOrderOf` reads as the sandbox delivered them
 * (2026-10-23, a checkout with no customer and metadata `{purpose, gift}`, paid with a test card):
 * the metadata copied from the checkout, and a customer Polar made for the email, with no external
 * id. The same checkout paid with an existing customer's email was filed under that customer,
 * external id and all.
 */
const guestOrder = (patch: Record<string, unknown> = {}) => ({
  metadata: { gift: '1bbb5840-195a-4e9c-87df-65b0760d7f41', purpose: 'gift' },
  customer: { external_id: null, email: 'gift-guest@example.test' },
  ...patch,
})
const MONTH = { id: '3fef3123-591e-4723-95e7-b19e4157f6cc', planKey: 'plus', months: 1, priceCents: 1500 }

test('a gift’s order names the gift made before its checkout, and the email it was paid with', () => {
  expect(giftOrderOf(guestOrder(), MONTH)).toEqual({
    gift: MONTH,
    giftId: '1bbb5840-195a-4e9c-87df-65b0760d7f41',
    payerEmail: 'gift-guest@example.test',
  })
  // A gift its paid order makes: no metadata of ours.
  expect(giftOrderOf(guestOrder({ metadata: {} }), MONTH)).toMatchObject({ giftId: null })
  // Only an id shaped like one of ours, and only on a gift product's order.
  expect(giftOrderOf(guestOrder({ metadata: { gift: '1; drop table' } }), MONTH).giftId).toBeNull()
  expect(giftOrderOf(guestOrder(), null)).toEqual({ gift: null, giftId: null, payerEmail: null })
})
