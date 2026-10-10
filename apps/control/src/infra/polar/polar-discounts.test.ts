/**
 * Discount codes through Polar's API, against a stand-in for it: what a new code is sent as,
 * what Polar's discounts read back as, which of them are this deployment's, and checkout leaving
 * room for a code.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { DiscountRefused, type NewDiscount } from '../../app/ports/optional.ts'
import { PLUS_PRODUCT, PolarStandIn, webhookSecret } from '../../testing/polar.ts'
import { PolarBilling } from './polar-billing.ts'

const OTHER_PRODUCT = '4c1f7a0e-93b2-4f57-a1de-0b5b7f3e9d21'

/** A discount shaped like API 2026-10's Discount: 20% off Plus for 3 months, unless patched. */
const polarDiscount = (patch: Record<string, unknown> = {}) => ({
  id: 'f0e1d2c3-b4a5-4968-8776-655443322110',
  created_at: '2026-10-01T12:00:00Z',
  modified_at: null,
  metadata: {},
  name: 'FRIENDS20',
  code: 'FRIENDS20',
  starts_at: null,
  ends_at: null,
  max_redemptions: null,
  max_redemptions_per_customer: null,
  redemptions_count: 4,
  organization_id: '1dbfc517-0bbf-4301-9ba8-555ca42b9737',
  type: 'percentage',
  duration: 'repeating',
  duration_in_months: 3,
  basis_points: 2000,
  products: [{ id: PLUS_PRODUCT, name: 'Plus', metadata: {} }],
  ...patch,
})

const page = (items: unknown[], maxPage = 1) => ({
  items,
  pagination: { total_count: items.length, max_page: maxPage },
})

const polar = new PolarStandIn()
let billing: PolarBilling

beforeAll(async () => {
  await polar.start()
  billing = new PolarBilling({
    accessToken: 'polar_oat_test',
    webhookSecret: webhookSecret(),
    server: 'sandbox',
    products: { plus: PLUS_PRODUCT },
    baseUrl: polar.url,
  })
})

afterAll(() => polar.close())

beforeEach(() => {
  polar.requests.length = 0
})

test('a checkout for a plan has a place for the customer to type a code', async () => {
  polar.reply = () => ({ status: 201, body: { id: 'co_1', url: 'https://sandbox.polar.sh/checkout/c' } })
  await billing.checkoutUrl({
    userId: 'user_1',
    email: 'player@example.com',
    planKey: 'plus',
    returnUrl: 'http://localhost:3000/account',
  })
  expect(JSON.parse(polar.requests.at(-1)?.body ?? '{}').allow_discount_codes).toBe(true)
})

test('a percentage for some months goes as basis points, limited to the plan products', async () => {
  polar.reply = () => ({ status: 201, body: polarDiscount() })
  const made = await billing.createDiscount({
    code: 'FRIENDS20',
    off: { kind: 'percent', percent: 20 },
    duration: { kind: 'months', months: 3 },
    maxRedemptions: null,
    endsAt: null,
  })
  const sent = polar.requests.at(-1)
  expect(`${sent?.method} ${sent?.path}`).toBe('POST /v1/discounts/')
  expect(JSON.parse(sent?.body ?? '')).toEqual({
    name: 'FRIENDS20',
    code: 'FRIENDS20',
    products: [PLUS_PRODUCT],
    max_redemptions: null,
    ends_at: null,
    duration: 'repeating',
    duration_in_months: 3,
    type: 'percentage',
    basis_points: 2000,
  })
  expect(made).toEqual({
    id: 'f0e1d2c3-b4a5-4968-8776-655443322110',
    code: 'FRIENDS20',
    off: { kind: 'percent', percent: 20 },
    duration: { kind: 'months', months: 3 },
    maxRedemptions: null,
    redemptions: 4,
    endsAt: null,
    createdAt: new Date('2026-10-01T12:00:00Z'),
  })
})

test('a fixed amount goes in dollars by currency, with its limits', async () => {
  const fixed = polarDiscount({
    type: 'fixed',
    duration: 'once',
    duration_in_months: undefined,
    basis_points: undefined,
    amount: 500,
    currency: 'usd',
    amounts: { usd: 500 },
    max_redemptions: 50,
    ends_at: '2026-12-31T23:59:59Z',
    redemptions_count: 0,
  })
  polar.reply = () => ({ status: 201, body: fixed })
  const input: NewDiscount = {
    code: 'WINTER5',
    off: { kind: 'amount', cents: 500 },
    duration: { kind: 'once' },
    maxRedemptions: 50,
    endsAt: new Date('2026-12-31T23:59:59Z'),
  }
  const made = await billing.createDiscount(input)
  expect(JSON.parse(polar.requests.at(-1)?.body ?? '')).toEqual({
    name: 'WINTER5',
    code: 'WINTER5',
    products: [PLUS_PRODUCT],
    max_redemptions: 50,
    ends_at: '2026-12-31T23:59:59.000Z',
    duration: 'once',
    type: 'fixed',
    amounts: { usd: 500 },
  })
  expect(made.off).toEqual({ kind: 'amount', cents: 500 })
  expect(made.duration).toEqual({ kind: 'once' })
  expect(made.maxRedemptions).toBe(50)
  expect(made.endsAt).toEqual(new Date('2026-12-31T23:59:59Z'))
})

test('a code Polar refuses comes back in its words', async () => {
  polar.reply = () => ({
    status: 422,
    body: {
      error: 'RequestValidationError',
      detail: [
        { loc: ['body', 'code'], msg: 'Discount with this code already exists.', type: 'value_error' },
      ],
    },
  })
  const refused = billing.createDiscount({
    code: 'FRIENDS20',
    off: { kind: 'percent', percent: 20 },
    duration: { kind: 'forever' },
    maxRedemptions: null,
    endsAt: null,
  })
  await expect(refused).rejects.toBeInstanceOf(DiscountRefused)
  await expect(refused).rejects.toThrow('Discount with this code already exists.')
})

test('the list reads every page, keeping codes for the plan products or for every product', async () => {
  polar.reply = (request) => {
    const asked = new URL(request.path, 'http://polar.test').searchParams
    if (asked.get('page') === '1')
      return {
        status: 200,
        body: page(
          [
            polarDiscount({ id: 'mine', redemptions_count: 7 }),
            polarDiscount({ id: 'theirs', products: [{ id: OTHER_PRODUCT }] }),
            polarDiscount({ id: 'no-code', code: null }),
          ],
          2,
        ),
      }
    return {
      status: 200,
      body: page([polarDiscount({ id: 'everything', code: 'ALL10', basis_points: 1000, products: [] })], 2),
    }
  }
  const found = await billing.discounts()
  expect(found.map((discount) => [discount.id, discount.code])).toEqual([
    ['mine', 'FRIENDS20'],
    ['everything', 'ALL10'],
  ])
  expect(found[0]?.redemptions).toBe(7)
  expect(found[1]?.off).toEqual({ kind: 'percent', percent: 10 })
  const asked = polar.requests.map((request) => new URL(request.path, 'http://polar.test'))
  expect(asked.map((url) => [url.pathname, url.searchParams.get('page')])).toEqual([
    ['/v1/discounts/', '1'],
    ['/v1/discounts/', '2'],
  ])
  expect(asked[0]?.searchParams.get('sorting')).toBe('-created_at')
})

test('only a code for the plans is deleted; one Polar no longer has is already gone', async () => {
  polar.reply = (request) =>
    request.method === 'GET' ? { status: 200, body: polarDiscount() } : { status: 204, body: null }
  expect((await billing.deleteDiscount('f0e1d2c3-b4a5-4968-8776-655443322110'))?.code).toBe('FRIENDS20')
  expect(polar.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
    'GET /v1/discounts/f0e1d2c3-b4a5-4968-8776-655443322110',
    'DELETE /v1/discounts/f0e1d2c3-b4a5-4968-8776-655443322110',
  ])

  polar.requests.length = 0
  polar.reply = () => ({ status: 200, body: polarDiscount({ products: [{ id: OTHER_PRODUCT }] }) })
  expect(await billing.deleteDiscount('theirs')).toBeNull()
  expect(polar.requests.map((request) => request.method)).toEqual(['GET'])

  polar.reply = () => ({ status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } })
  expect(await billing.deleteDiscount('gone')).toBeNull()
})
