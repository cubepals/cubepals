// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Products at an early price: read from Polar's product shape, the newest one offered, and every one
 * of them, archived or not, mapped back to its plan in a standing and an order.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import {
  CORE_PRODUCT,
  customerState,
  earlyProduct,
  METERED_PRICE,
  order,
  orderEvent,
  orderItem,
  PLUS_PRODUCT,
  PolarStandIn,
  page,
  product,
  signed,
  stateChanged,
  webhookSecret,
} from '../../testing/polar.ts'
import { PolarBilling } from './polar-billing.ts'
import { earlyOf, newestEarly } from './polar-early.ts'

const PLANS = new Set(['core', 'plus'])
const EARLY_CORE = '7e0c1a52-9d3b-4c11-8f2e-5a6b7c8d9e01'
const EARLY_CORE_LATER = '7e0c1a52-9d3b-4c11-8f2e-5a6b7c8d9f01'
const EARLY_PLUS = '7e0c1a52-9d3b-4c11-8f2e-5a6b7c8da001'

const earlyCore = (id = EARLY_CORE, patch = {}) =>
  earlyProduct(id, { plan: 'core', included_units: 90, most_extra_units: 12, version: 1 }, 700, patch)
const earlyPlus = () => earlyProduct(EARLY_PLUS, { plan: 'plus', included_units: 160, version: 1 }, 1200)

describe('an early product, read from Polar', () => {
  test('is its plan, price, hours and cap', () => {
    expect(earlyOf(earlyCore(), PLANS)).toEqual({
      id: EARLY_CORE,
      planKey: 'core',
      priceCents: 700,
      includedUnits: 90,
      mostExtraUnits: 12,
      archived: false,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    })
    expect(earlyOf(earlyPlus(), PLANS)).toMatchObject({
      planKey: 'plus',
      includedUnits: 160,
      mostExtraUnits: null,
    })
  })

  test('reads hours given as digits, and an archived one as archived', () => {
    const product = earlyProduct(EARLY_CORE, { plan: 'core', included_units: '90' }, 700, {
      is_archived: true,
    })
    expect(earlyOf(product, PLANS)).toMatchObject({ includedUnits: 90, archived: true })
  })

  test('is nothing when it sells no plan here, has no whole hours, or isn’t monthly', () => {
    const with_ = (metadata: Record<string, string | number>, patch = {}) =>
      earlyOf(earlyProduct(EARLY_CORE, metadata, 700, patch), PLANS)
    expect(with_({ plan: 'gold', included_units: 90 })).toBeNull()
    expect(with_({ plan: 'core' })).toBeNull()
    expect(with_({ plan: 'core', included_units: 9.5 })).toBeNull()
    expect(with_({ plan: 'core', included_units: -1 })).toBeNull()
    expect(with_({ plan: 'core', included_units: 90, most_extra_units: 'many' })).toBeNull()
    expect(with_({ plan: 'core', included_units: 90 }, { recurring_interval: 'year' })).toBeNull()
    expect(with_({ plan: 'core', included_units: 90, terms: 'other' })).toBeNull()
    expect(earlyOf(product(PLUS_PRODUCT), PLANS)).toBeNull()
  })

  test('the newest one not archived is the one offered', () => {
    const first = earlyOf(earlyCore(), PLANS)
    const later = earlyOf(earlyCore(EARLY_CORE_LATER, { created_at: '2026-10-01T00:00:00Z' }), PLANS)
    const archived = earlyOf(
      earlyCore('7e0c1a52-9d3b-4c11-8f2e-5a6b7c8db001', {
        created_at: '2026-10-05T00:00:00Z',
        is_archived: true,
      }),
      PLANS,
    )
    const all = [first, later, archived].filter((each) => each !== null)
    expect(newestEarly(all, 'core')?.id).toBe(EARLY_CORE_LATER)
    expect(newestEarly(all, 'plus')).toBeNull()
  })
})

describe('PolarBilling with early products', () => {
  const polar = new PolarStandIn()
  const secret = webhookSecret()
  let billing: PolarBilling
  /** The early products Polar holds, archived ones too. */
  let held = [earlyCore(EARLY_CORE, { is_archived: true }), earlyCore(EARLY_CORE_LATER), earlyPlus()]

  beforeAll(async () => {
    await polar.start()
    polar.reply = ({ method, path }) => {
      if (method === 'GET' && path.startsWith('/v1/products/?'))
        return {
          status: 200,
          body: page(path.includes('terms%5D=early') || path.includes('terms]=early') ? held : []),
        }
      const id = /^\/v1\/products\/([^/?]+)/.exec(path)?.[1]
      const one = held.find((each) => each.id === id)
      if (method === 'GET' && one) return { status: 200, body: one }
      return { status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } }
    }
  })

  beforeEach(() => {
    held = [earlyCore(EARLY_CORE, { is_archived: true }), earlyCore(EARLY_CORE_LATER), earlyPlus()]
    billing = new PolarBilling({
      accessToken: 'polar_oat_test',
      webhookSecret: secret,
      server: 'sandbox',
      products: { core: CORE_PRODUCT, plus: PLUS_PRODUCT },
      baseUrl: polar.url,
    })
  })

  afterAll(() => polar.close())

  test('offers the newest early product for a plan, found by its metadata', async () => {
    expect(await billing.earlyProduct('core')).toMatchObject({ id: EARLY_CORE_LATER, priceCents: 700 })
    expect((await billing.earlyProduct('plus'))?.id).toBe(EARLY_PLUS)
    const listed = polar.requests.filter((request) => request.path.startsWith('/v1/products/?'))
    expect(listed).toHaveLength(1)
    expect(decodeURIComponent(listed[0]?.path ?? '')).toContain('metadata[terms]=early')
  })

  test('a subscription on an archived early product still gives its plan', async () => {
    const state = customerState('user_early', {}, { product_id: EARLY_CORE })
    polar.states.set('user_early', state)
    const event = await billing.receive(...sent(stateChanged(state)))
    const now = await billing.stateOf('user_early')
    expect(event).toMatchObject({ kind: 'standing', state: { subscription: { planKey: 'core' } } })
    expect(now?.subscription?.planKey).toBe('core')
  })

  test('of an early Core and a regular Plus paying at once, Plus speaks for the account', async () => {
    const state = customerState('user_both', {}, { product_id: EARLY_CORE_LATER })
    const plus = customerState('user_both').active_subscriptions[0]
    if (plus === undefined) throw new Error('A state has a subscription')
    state.active_subscriptions.push({ ...plus, id: 'f0000000-0000-4000-8000-000000000001' })
    polar.states.set('user_both', state)
    expect((await billing.stateOf('user_both'))?.subscription?.planKey).toBe('plus')
  })

  test('a product that sells no plan grants nothing', async () => {
    const state = customerState('user_none', {}, { product_id: 'a0000000-0000-4000-8000-000000000009' })
    polar.states.set('user_none', state)
    expect((await billing.stateOf('user_none'))?.subscription).toBeNull()
  })

  test('an order on an early product is its plan’s, and its metered line is extra play', async () => {
    const meteredOfEarly = `${EARLY_PLUS.slice(0, -1)}2`
    const paid = order('user_early', {
      product_id: EARLY_PLUS,
      items: [orderItem(1200, `${EARLY_PLUS.slice(0, -1)}1`), orderItem(250, meteredOfEarly)],
    })
    const event = await billing.receive(...sent(orderEvent(paid)))
    expect(event).toMatchObject({ kind: 'order', order: { planKey: 'plus', extraCents: 250, chipIn: null } })
    // A price of another product named on the order counts for nothing here.
    expect(METERED_PRICE).not.toBe(meteredOfEarly)
  })

  test('an early product made after the last read is read once a minute has passed', async () => {
    expect((await billing.earlyProduct('core'))?.id).toBe(EARLY_CORE_LATER)
    const newer = earlyCore('7e0c1a52-9d3b-4c11-8f2e-5a6b7c8dc001', { created_at: '2026-10-20T00:00:00Z' })
    held = [...held, newer]
    const paid = order('user_new', { product_id: newer.id, items: [] })
    // Read a moment ago: a product it doesn't hold waits for the minute.
    expect(await billing.receive(...sent(orderEvent(paid)))).toMatchObject({ order: { planKey: null } })
    setSystemTime(new Date(Date.now() + MINUTE_MS + 1000))
    try {
      expect(await billing.receive(...sent(orderEvent(paid)))).toMatchObject({ order: { planKey: 'core' } })
      expect((await billing.earlyProduct('core'))?.id).toBe(newer.id)
    } finally {
      setSystemTime()
    }
  })

  /** A delivery as Polar signs it, for `receive`. */
  function sent(event: unknown): [string, Record<string, string>] {
    const { body, headers } = signed(event, secret)
    return [body, headers]
  }
})
