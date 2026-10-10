import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PolarClientError } from '@polar-sh/sdk'
import { BillingUnavailable, WebhookRejected } from '../../app/ports/optional.ts'
import {
  order,
  orderEvent,
  PLUS_PRODUCT,
  PolarStandIn,
  signed as sign,
  customerState as state,
  stateChanged,
  subscription,
  webhookSecret,
} from '../../testing/polar.ts'
import { PolarBilling } from './polar-billing.ts'

const PLUS = PLUS_PRODUCT
const SECRET = webhookSecret()
const customerState = (patch: Record<string, unknown> = {}, subscription: Record<string, unknown> = {}) =>
  state('user_123', patch, { current_period_end: '2026-10-01T00:00:00Z', ...subscription })
const signed = (event: unknown, secret = SECRET, at = new Date()) => sign(event, secret, at)

/** What `customerState()` says, as a standing: Plus, renewing. */
const PLUS_STANDING = {
  userId: 'user_123',
  externalCustomerId: '992fae2a-2a17-4b7a-8d9d-e45177024a7c',
  subscription: {
    externalSubscriptionId: 'e5149aae-e521-42b9-b24c-abb3d71eea2e',
    planKey: 'plus',
    status: 'active',
    currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    canceledAt: null,
  },
}

describe('PolarBilling', () => {
  const requests: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = []
  let reply: () => { status: number; body: unknown } = () => ({ status: 200, body: {} })
  let polar: Server
  let billing: PolarBilling

  beforeAll(async () => {
    polar = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          path: request.url ?? '',
          headers: request.headers,
          body,
        })
        const answer = reply()
        response.statusCode = answer.status
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(answer.body))
      })
    })
    await new Promise<void>((resolve) => polar.listen(0, '127.0.0.1', resolve))
    billing = new PolarBilling({
      accessToken: 'polar_oat_test',
      webhookSecret: SECRET,
      server: 'sandbox',
      products: { plus: PLUS },
      baseUrl: `http://127.0.0.1:${(polar.address() as AddressInfo).port}`,
    })
  })

  afterAll(() => {
    polar.close()
  })

  test("a checkout sells the plan's product to the user, pinned to API 2026-10", async () => {
    reply = () => ({ status: 201, body: { id: 'co_1', url: 'https://sandbox.polar.sh/checkout/polar_c_1' } })
    const url = await billing.checkoutUrl({
      userId: 'user_123',
      email: 'player@example.com',
      planKey: 'plus',
      returnUrl: 'http://localhost:3000/account',
    })
    expect(url).toBe('https://sandbox.polar.sh/checkout/polar_c_1')
    const sent = requests.at(-1)
    expect(`${sent?.method} ${sent?.path}`).toBe('POST /v1/checkouts/')
    expect(sent?.headers['polar-version']).toBe('2026-10')
    expect(sent?.headers.authorization).toBe('Bearer polar_oat_test')
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      products: [PLUS],
      external_customer_id: 'user_123',
      customer_email: 'player@example.com',
      success_url: 'http://localhost:3000/account',
      return_url: 'http://localhost:3000/account',
    })
    await expect(
      billing.checkoutUrl({ userId: 'u', email: 'e@x.test', planKey: 'gold', returnUrl: 'http://x.test' }),
    ).rejects.toThrow(/gold/)
  })

  test('an address Polar won\u2019t take opens the checkout without it, for the person to give one there', async () => {
    const tried: unknown[] = []
    reply = () => {
      const body = JSON.parse(requests.at(-1)?.body ?? '{}')
      tried.push(body.customer_email)
      return body.customer_email === undefined
        ? { status: 201, body: { id: 'co_2', url: 'https://sandbox.polar.sh/checkout/polar_c_2' } }
        : {
            status: 422,
            body: {
              error: 'RequestValidationError',
              // As Polar answers: one problem for each shape a checkout could take.
              detail: [
                {
                  loc: ['body', 'CheckoutProductCreate', 'product_id'],
                  msg: 'Field required',
                  type: 'missing',
                },
                {
                  loc: ['body', 'CheckoutProductsCreate', 'customer_email'],
                  msg: 'value is not a valid email address: The part after the @-sign is a special-use or reserved name that cannot be used with email.',
                  type: 'value_error',
                },
              ],
            },
          }
    }
    const url = await billing.checkoutUrl({
      userId: 'user_9',
      email: 'player@example.test',
      planKey: 'plus',
      returnUrl: 'http://localhost:3000/account',
    })
    expect(url).toBe('https://sandbox.polar.sh/checkout/polar_c_2')
    expect(tried).toEqual(['player@example.test', undefined])

    // Refused for anything else, it is not tried again.
    reply = () => ({
      status: 422,
      body: {
        error: 'RequestValidationError',
        detail: [{ loc: ['body', 'products'], msg: 'unknown product' }],
      },
    })
    await expect(
      billing.checkoutUrl({
        userId: 'user_9',
        email: 'player@example.com',
        planKey: 'plus',
        returnUrl: 'http://x',
      }),
    ).rejects.toThrow()
  })

  test('the portal opens for the user by their own id', async () => {
    reply = () => ({
      status: 201,
      body: { id: 'cs_1', customer_portal_url: 'https://sandbox.polar.sh/portal?t=1' },
    })
    expect(await billing.portalUrl({ userId: 'user_123', returnUrl: 'http://localhost:3000/account' })).toBe(
      'https://sandbox.polar.sh/portal?t=1',
    )
    const sent = requests.at(-1)
    expect(`${sent?.method} ${sent?.path}`).toBe('POST /v1/customer-sessions/')
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      external_customer_id: 'user_123',
      return_url: 'http://localhost:3000/account',
    })
  })

  test('a customer state webhook reports the plan its product sells', async () => {
    reply = () => ({ status: 200, body: customerState() })
    const delivery = signed(stateChanged(customerState()))
    expect(await billing.receive(delivery.body, delivery.headers)).toEqual({
      kind: 'standing',
      state: PLUS_STANDING,
    })
    expect(requests.at(-1)?.path).toBe('/v1/customers/external/user_123/state')
  })

  test('a delivery says whose standing changed; the standing is Polar’s now, not as it was sent', async () => {
    // A retry of the delivery that said Plus, arriving after Plus ended.
    reply = () => ({ status: 200, body: customerState({ active_subscriptions: [] }) })
    const stale = signed(stateChanged(customerState()))
    expect(await billing.receive(stale.body, stale.headers)).toMatchObject({
      kind: 'standing',
      state: { userId: 'user_123', subscription: null },
    })
    // A customer Polar no longer has pays for nothing.
    reply = () => ({ status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } })
    expect(await billing.receive(stale.body, stale.headers)).toMatchObject({
      kind: 'standing',
      state: {
        userId: 'user_123',
        externalCustomerId: '992fae2a-2a17-4b7a-8d9d-e45177024a7c',
        subscription: null,
      },
    })
    // Polar not answering fails the delivery, so Polar sends it again rather than it being lost.
    reply = () => ({ status: 503, body: { detail: 'maintenance' } })
    await expect(billing.receive(stale.body, stale.headers)).rejects.toBeInstanceOf(BillingUnavailable)
  })

  test('an order webhook reports what was paid, in cents, and the plan its product sells', async () => {
    const paid = signed(orderEvent(order('user_123', { tax_amount: 300, total_amount: 1800 })))
    expect(await billing.receive(paid.body, paid.headers)).toMatchObject({
      kind: 'order',
      order: {
        externalOrderId: 'b1c4e2f0-6f1d-4a57-9e57-7c1f0f4d2a11',
        userId: 'user_123',
        planKey: 'plus',
        billingReason: 'subscription_create',
        currency: 'usd',
        subtotalCents: 1500,
        discountCents: 0,
        netCents: 1500,
        taxCents: 300,
        totalCents: 1800,
        refundedCents: 0,
        orderedAt: new Date('2026-09-26T10:00:00Z'),
      },
    })
    const refunded = signed(orderEvent(order(null, { refunded_amount: 1500 }), 'order.refunded'))
    expect(await billing.receive(refunded.body, refunded.headers)).toMatchObject({
      kind: 'order',
      order: { userId: null, refundedCents: 1500 },
    })
  })

  test('nothing paid, a product no plan names, and a stranger report no plan', async () => {
    const standing = async (state: unknown) => {
      reply = () => ({ status: 200, body: state })
      const delivery = signed(stateChanged(state))
      const event = await billing.receive(delivery.body, delivery.headers)
      return event?.kind === 'standing' ? event.state : null
    }
    expect((await standing(customerState({ active_subscriptions: [] })))?.subscription).toBeNull()
    expect((await standing(customerState({}, { product_id: 'another-product' })))?.subscription).toBeNull()
    const stranger = signed(stateChanged(customerState({ external_id: null })))
    expect(await billing.receive(stranger.body, stranger.headers)).toBeNull()
  })

  test('forged, altered and replayed deliveries are rejected', async () => {
    const forged = signed(stateChanged(customerState()), `whsec_${randomBytes(24).toString('base64')}`)
    await expect(billing.receive(forged.body, forged.headers)).rejects.toBeInstanceOf(WebhookRejected)
    const real = signed(stateChanged(customerState()))
    await expect(
      billing.receive(real.body.replace('user_123', 'user_999'), real.headers),
    ).rejects.toBeInstanceOf(WebhookRejected)
    const old = signed(stateChanged(customerState()), SECRET, new Date(Date.now() - 10 * 60_000))
    await expect(billing.receive(old.body, old.headers)).rejects.toBeInstanceOf(WebhookRejected)
  })

  test('other events, and ones this API version does not know, report nothing', async () => {
    const product = signed({
      type: 'product.updated',
      timestamp: new Date().toISOString(),
      api_version: '2026-10',
      data: {},
    })
    expect(await billing.receive(product.body, product.headers)).toBeNull()
    const future = signed({ type: 'wallet.topped_up', timestamp: new Date().toISOString(), data: {} })
    expect(await billing.receive(future.body, future.headers)).toBeNull()
  })

  test('an authentic delivery with a malformed state is an error, not a lost plan', async () => {
    const broken = signed(stateChanged({ id: 5 }))
    await expect(billing.receive(broken.body, broken.headers)).rejects.toThrow()
    // The same for an order: answered with an error, so Polar delivers it again, not lost revenue.
    const brokenOrder = signed(orderEvent({ id: 'o_1' }))
    await expect(billing.receive(brokenOrder.body, brokenOrder.headers)).rejects.toThrow()
  })

  test("a customer's standing on request; someone never billed is null", async () => {
    reply = () => ({ status: 200, body: customerState() })
    expect((await billing.stateOf('user_123'))?.subscription?.planKey).toBe('plus')
    expect(requests.at(-1)?.path).toBe('/v1/customers/external/user_123/state')
    reply = () => ({ status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } })
    expect(await billing.stateOf('user_404')).toBeNull()
  })

  test("Polar's outages and rate limits are BillingUnavailable; our own mistakes are not", async () => {
    for (const status of [429, 500, 503]) {
      reply = () => ({ status, body: { detail: 'x' } })
      await expect(billing.stateOf('user_123')).rejects.toBeInstanceOf(BillingUnavailable)
    }
    reply = () => ({ status: 422, body: { detail: [{ msg: 'bad' }] } })
    await expect(billing.stateOf('user_123')).rejects.toBeInstanceOf(PolarClientError)
    const unreachable = new PolarBilling({
      accessToken: 't',
      webhookSecret: SECRET,
      server: 'sandbox',
      products: {},
      baseUrl: 'http://127.0.0.1:1',
    })
    await expect(unreachable.stateOf('user_123')).rejects.toBeInstanceOf(BillingUnavailable)
  })

  test('a subscription left out of a standing is past due while Polar retries it, else it ended', async () => {
    reply = () => ({
      status: 200,
      body: subscription('sub_1', {
        status: 'past_due',
        past_due_at: '2026-10-01T00:04:00Z',
        ended_at: null,
      }),
    })
    expect(await billing.pastDueSince('sub_1')).toEqual(new Date('2026-10-01T00:04:00Z'))
    expect(`${requests.at(-1)?.method} ${requests.at(-1)?.path}`).toBe('GET /v1/subscriptions/sub_1')
    // Without Polar's stamp, the charge that failed was the renewal at the end of the period.
    reply = () => ({ status: 200, body: subscription('sub_1', { status: 'past_due', past_due_at: null }) })
    expect(await billing.pastDueSince('sub_1')).toEqual(new Date('2026-10-01T00:00:00Z'))
    reply = () => ({ status: 200, body: subscription('sub_1') })
    expect(await billing.pastDueSince('sub_1')).toBeNull()
    reply = () => ({ status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } })
    expect(await billing.pastDueSince('sub_gone')).toBeNull()
    reply = () => ({ status: 503, body: { detail: 'maintenance' } })
    expect(await billing.pastDueSince('sub_1').catch((error) => error)).toBeInstanceOf(BillingUnavailable)
  })
})

describe('PolarBilling and extra play', () => {
  const polar = new PolarStandIn()
  let billing: PolarBilling

  beforeAll(async () => {
    await polar.start()
    billing = new PolarBilling({
      accessToken: 'polar_oat_test',
      webhookSecret: SECRET,
      server: 'sandbox',
      products: { plus: PLUS },
      baseUrl: polar.url,
    })
  })

  afterAll(() => polar.close())

  test("an order's metered line is extra play, told apart by the product's prices", async () => {
    polar.reply = () => ({
      status: 200,
      body: {
        id: PLUS,
        prices: [
          { id: 'price_fixed', amount_type: 'fixed' },
          { id: 'price_metered', amount_type: 'metered_unit' },
        ],
      },
    })
    const renewal = order('user_123', {
      status: 'pending',
      billing_reason: 'subscription_cycle',
      items: [
        { amount: 1500, product_price_id: 'price_fixed' },
        { amount: 325, product_price_id: 'price_metered' },
      ],
    })
    const made = signed(orderEvent(renewal, 'order.created'))
    expect(await billing.receive(made.body, made.headers)).toMatchObject({
      kind: 'order',
      order: {
        status: 'pending',
        extraCents: 325,
        billingReason: 'subscription_cycle',
        externalSubscriptionId: 'e5149aae-e521-42b9-b24c-abb3d71eea2e',
      },
    })
    expect(polar.requests.at(-1)?.path).toBe(`/v1/products/${PLUS}`)
    // The prices are read once; the next order is told apart from what was read.
    const seen = polar.requests.length
    const again = signed(orderEvent({ ...renewal, status: 'paid' }, 'order.updated'))
    expect(await billing.receive(again.body, again.headers)).toMatchObject({ order: { extraCents: 325 } })
    expect(polar.requests.length).toBe(seen)
  })

  test('a subscription that went past due, was cancelled or ended says whose standing to read', async () => {
    for (const type of ['subscription.past_due', 'subscription.canceled', 'subscription.revoked']) {
      polar.states.set('user_123', customerState({ active_subscriptions: [] }))
      const delivery = signed({
        type,
        timestamp: new Date().toISOString(),
        api_version: '2026-10',
        data: { ...subscription('sub_1'), customer: { external_id: 'user_123' } },
      })
      const event = await billing.receive(delivery.body, delivery.headers)
      expect(event).toMatchObject({ kind: 'standing', state: { userId: 'user_123', subscription: null } })
      expect(polar.requests.at(-1)?.path).toBe('/v1/customers/external/user_123/state')
    }
  })

  test('extra play goes to Polar as play.extra events, hours in their metadata, each with its id', async () => {
    polar.reply = () => ({ status: 200, body: { inserted: 2, duplicates: 0 } })
    await billing.reportUsage([
      { externalId: 'extra:u1:2026-10:1', userId: 'u1', hours: 1.25, at: new Date('2026-10-09T12:00:00Z') },
      { externalId: 'extra:u2:2026-10:4', userId: 'u2', hours: 0.1, at: new Date('2026-10-09T12:01:00Z') },
    ])
    const sent = polar.requests.at(-1)
    expect(`${sent?.method} ${sent?.path}`).toBe('POST /v1/events/ingest')
    expect(sent?.headers['polar-version']).toBe('2026-10')
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({
      events: [
        {
          name: 'play.extra',
          external_customer_id: 'u1',
          external_id: 'extra:u1:2026-10:1',
          timestamp: '2026-10-09T12:00:00.000Z',
          metadata: { hours: 1.25 },
        },
        {
          name: 'play.extra',
          external_customer_id: 'u2',
          external_id: 'extra:u2:2026-10:4',
          timestamp: '2026-10-09T12:01:00.000Z',
          metadata: { hours: 0.1 },
        },
      ],
    })
    // Nothing to send is no request; Polar down is BillingUnavailable, to be sent again.
    const before = polar.requests.length
    await billing.reportUsage([])
    expect(polar.requests.length).toBe(before)
    polar.reply = () => ({ status: 503, body: { detail: 'maintenance' } })
    await expect(
      billing.reportUsage([{ externalId: 'x', userId: 'u1', hours: 1, at: new Date() }]),
    ).rejects.toBeInstanceOf(BillingUnavailable)
  })
})

describe('PolarBilling paying a balance', () => {
  const polar = new PolarStandIn()
  let billing: PolarBilling

  beforeAll(async () => {
    await polar.start()
    billing = new PolarBilling({
      accessToken: 'polar_oat_test',
      webhookSecret: SECRET,
      server: 'sandbox',
      products: { plus: PLUS },
      baseUrl: polar.url,
    })
  })

  afterAll(() => polar.close())

  test('paying a balance opens without an address Polar won’t take, as a plan checkout does', async () => {
    const tried: unknown[] = []
    polar.reply = (sent) => {
      if (sent.method === 'GET')
        return {
          status: 200,
          body: { items: sent.path.startsWith('/v1/checkouts') ? [] : [{ id: 'balance_product' }] },
        }
      const body = JSON.parse(polar.requests.at(-1)?.body ?? '{}')
      tried.push(body.customer_email)
      return body.customer_email === undefined
        ? { status: 201, body: { id: 'co_3', url: 'https://sandbox.polar.sh/checkout/polar_c_3' } }
        : {
            status: 422,
            body: {
              error: 'RequestValidationError',
              detail: [{ loc: ['body', 'CheckoutProductsCreate', 'customer_email'], msg: 'reserved name' }],
            },
          }
    }
    const url = await billing.settleUrl({
      userId: 'user_9',
      email: 'player@example.test',
      cents: 1688,
      settles: ['order_1'],
      returnUrl: 'http://localhost:3000/account',
    })
    expect(url).toBe('https://sandbox.polar.sh/checkout/polar_c_3')
    expect(tried).toEqual(['player@example.test', undefined])
    expect(JSON.parse(polar.requests.at(-1)?.body ?? '')).toMatchObject({
      products: ['balance_product'],
      metadata: { settles: 'order_1' },
      external_customer_id: 'user_9',
    })
  })
})
