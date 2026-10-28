// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stand-in for Polar's API, and what it answers and delivers, each built as `@polar-sh/sdk`'s
 * API 2026-10 `models` type it, so a change in Polar's shapes fails the build here rather than
 * leaving a test that passes against a shape Polar no longer sends. Webhook deliveries are signed
 * the Standard Webhooks way, as Polar signs them.
 *
 * It holds no assertion, and is not the control plane around it (`polar-world.ts`).
 */
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { HOUR_MS } from '@blockly/contracts/durations'
import type { models, webhooks } from '../infra/polar/polar-models.ts'

/** The Polar product that sells `plus` in tests. */
export const PLUS_PRODUCT = 'd8dd2de1-21b7-4a41-8bc3-ce909c0cfe23'
/** The product that sells Core: $9.99 a month, tax inclusive, and the metered Extra play price. */
export const CORE_PRODUCT = '5b1c0c6e-3f0a-4c58-9b0e-6f1f4c2f7a10'
/** Core's own price, and its metered one, which bills extra play as Plus' does. */
export const CORE_FIXED_PRICE = '5b1c0c6e-3f0a-4c58-9b0e-6f1f4c2f7a11'
export const CORE_METERED_PRICE = '5b1c0c6e-3f0a-4c58-9b0e-6f1f4c2f7a12'
/** Plus' own price, and its metered one, which bills extra play. */
export const FIXED_PRICE = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c001'
export const METERED_PRICE = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c002'

const CUSTOMER = '992fae2a-2a17-4b7a-8d9d-e45177024a7c'
const ORGANIZATION = '1dbfc517-0bbf-4301-9ba8-555ca42b9737'
const API_VERSION: models.ApiVersion = '2026-10'

/** What Polar answers a request with. */
export type Answer = { status: number; body: unknown }

/** Polar's answer for anything it doesn't have. */
export const notFound = {
  status: 404,
  body: { error: 'ResourceNotFound', detail: 'Not found' } satisfies models.ResourceNotFound,
}

/** Polar refusing a request it can't take, with each problem it found. */
export const invalidRequest = (...detail: models.ValidationError[]) => ({
  status: 422,
  body: { detail } satisfies models.HTTPValidationError,
})

/**
 * Polar down (5xx) or asked too often (429). The SDK models neither body; this is the `detail`
 * FastAPI, which Polar's API is built on, answers an HTTP error with.
 */
export const failing = (status = 503) => ({ status, body: { detail: 'maintenance' } })

/** Polar refusing Blockly's own token: revoked (401), or short a scope (403). */
export const tokenRefused = (status: 401 | 403) => ({
  status,
  body:
    status === 401
      ? ({ error: 'Unauthorized', detail: 'Invalid token' } satisfies models.Unauthorized)
      : ({ error: 'NotPermitted', detail: 'Not permitted' } satisfies models.NotPermitted),
})

/** One page of a list, the last unless `maxPage` says otherwise. */
export const page = <T>(items: T[], maxPage = 1) => ({
  items,
  pagination: { total_count: items.length, max_page: maxPage } satisfies models.Pagination,
})

/** A webhook secret in Polar's format. */
export const webhookSecret = () => `whsec_${randomBytes(24).toString('base64')}`

/** A customer as an order or a subscription carries it, with the external id Blockly gave it. */
export const customer = (externalId: string | null): models.CustomerIndividual => ({
  id: CUSTOMER,
  created_at: '2026-09-01T00:00:00Z',
  modified_at: null,
  metadata: {},
  external_id: externalId,
  email: 'player@example.com',
  email_verified: true,
  type: 'individual',
  name: null,
  billing_name: null,
  billing_address: null,
  tax_id: null,
  organization_id: ORGANIZATION,
  deleted_at: null,
  first_user_event_at: null,
  avatar_url: null,
})

/**
 * A subscription in a customer's state. SDK 1.0.2 types its `status` as `Status`, which is a
 * benefit grant's (`granted`, `disabled`); Polar lists only a subscription that pays now here,
 * `active` or `trialing`, as `polar-billing.ts` reads it.
 */
export type StateSubscription = Omit<models.CustomerStateSubscription, 'status'> & {
  status: Extract<models.SubscriptionStatus, 'active' | 'trialing'>
}
export type CustomerState = Omit<models.CustomerStateIndividual, 'active_subscriptions'> & {
  active_subscriptions: StateSubscription[]
}

/** A customer's state, paying for plus unless patched. */
export const customerState = (
  externalId: string | null,
  patch: Partial<CustomerState> = {},
  subscription: Partial<StateSubscription> = {},
): CustomerState => ({
  ...customer(externalId),
  active_subscriptions: [
    {
      id: 'e5149aae-e521-42b9-b24c-abb3d71eea2e',
      created_at: '2026-09-01T00:00:00Z',
      modified_at: null,
      status: 'active',
      amount: 500,
      currency: 'usd',
      recurring_interval: 'month',
      current_period_start: '2026-09-01T00:00:00Z',
      current_period_end: '2099-10-01T00:00:00Z',
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      started_at: '2026-09-01T00:00:00Z',
      ends_at: null,
      product_id: PLUS_PRODUCT,
      discount_id: null,
      seats: null,
      units: null,
      meters: [],
      metadata: {},
      ...subscription,
    },
  ],
  granted_benefits: [],
  active_meters: [],
  ...patch,
})

/**
 * A price of a product: its own, or the `metered` one extra play is billed by. Plus' own is $15
 * here; Core's are as the sandbox product holds them: $9.99, then 25 cents an hour up to $15 a
 * period, both tax inclusive.
 */
const price = (id: string, product: string, metered: boolean): models.ProductPrice => {
  const core = product === CORE_PRODUCT
  const common = {
    id,
    created_at: '2026-09-01T00:00:00Z',
    modified_at: null,
    source: 'catalog' as const,
    price_currency: 'usd',
    tax_behavior: core ? ('inclusive' as const) : null,
    is_archived: false,
    product_id: product,
  }
  return metered
    ? {
        ...common,
        amount_type: 'metered_unit',
        cap_amount: core ? 1500 : null,
        meter_id: 'c3a1d2b4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        meter: {
          id: 'c3a1d2b4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
          name: 'Extra play',
          unit: 'scalar',
          custom_label: null,
          custom_multiplier: null,
        },
        unit_amount: core ? '25' : '250',
      }
    : { ...common, amount_type: 'fixed', price_amount: core ? 999 : 1500 }
}

/** A product; Plus, monthly, with its own price and its metered one, unless it is another. */
export const product = (id: string, patch: Partial<models.Product> = {}): models.Product => ({
  id,
  created_at: '2026-09-01T00:00:00Z',
  modified_at: null,
  trial_interval: null,
  trial_interval_count: null,
  name: id === PLUS_PRODUCT ? 'Plus' : id === CORE_PRODUCT ? 'Core' : 'Balance',
  description: null,
  visibility: 'public',
  recurring_interval: id === PLUS_PRODUCT || id === CORE_PRODUCT ? 'month' : null,
  recurring_interval_count: id === PLUS_PRODUCT || id === CORE_PRODUCT ? 1 : null,
  meter_interval: null,
  meter_interval_count: null,
  is_recurring: id === PLUS_PRODUCT || id === CORE_PRODUCT,
  is_archived: false,
  organization_id: ORGANIZATION,
  metadata: {},
  is_deletable: false,
  prices:
    id === PLUS_PRODUCT
      ? [price(FIXED_PRICE, id, false), price(METERED_PRICE, id, true)]
      : id === CORE_PRODUCT
        ? [price(CORE_FIXED_PRICE, id, false), price(CORE_METERED_PRICE, id, true)]
        : [],
  benefits: [],
  medias: [],
  attached_custom_fields: [],
  ...patch,
})

/**
 * A product at an early price for `metadata.plan`: monthly and private, with a fixed price of its own
 * and the metered one extra play is billed by, both tax inclusive.
 */
export const earlyProduct = (
  id: string,
  metadata: Record<string, string | number>,
  cents: number,
  patch: Partial<models.Product> = {},
): models.Product =>
  product(id, {
    name: `Cubepals ${metadata.plan}`,
    visibility: 'private',
    recurring_interval: 'month',
    recurring_interval_count: 1,
    is_recurring: true,
    metadata: { terms: 'early', ...metadata },
    prices: [
      {
        ...price(`${id.slice(0, -1)}1`, id, false),
        price_amount: cents,
        tax_behavior: 'inclusive',
      } as models.ProductPrice,
      { ...price(`${id.slice(0, -1)}2`, id, true), tax_behavior: 'inclusive' } as models.ProductPrice,
    ],
    ...patch,
  })

/** A subscription: Plus, cancelled and ended, unless patched. */
export const subscription = (id: string, patch: Partial<models.Subscription> = {}): models.Subscription => ({
  id,
  created_at: '2026-09-01T00:00:00Z',
  modified_at: '2026-09-26T10:00:00Z',
  amount: 1500,
  currency: 'usd',
  recurring_interval: 'month',
  recurring_interval_count: 1,
  status: 'canceled',
  current_period_start: '2026-09-01T00:00:00Z',
  current_period_end: '2026-10-01T00:00:00Z',
  current_meter_period_start: null,
  current_meter_period_end: null,
  trial_start: null,
  trial_end: null,
  cancel_at_period_end: false,
  canceled_at: '2026-09-26T10:00:00Z',
  started_at: '2026-09-01T00:00:00Z',
  ends_at: null,
  ended_at: '2026-09-26T10:00:00Z',
  past_due_at: null,
  pause_at_period_end: false,
  paused_at: null,
  resumes_at: null,
  customer_id: CUSTOMER,
  product_id: PLUS_PRODUCT,
  discount_id: null,
  checkout_id: null,
  units: null,
  customer_cancellation_reason: null,
  customer_cancellation_comment: null,
  metadata: {},
  customer: customer(null),
  product: product(PLUS_PRODUCT),
  discount: null,
  prices: product(PLUS_PRODUCT).prices,
  meters: [],
  pending_update: null,
  ...patch,
})

/** A line of an order: `amount` cents charged at `price`. */
export const orderItem = (amount: number, price: string): models.OrderItemSchema => ({
  id: `item-${price}`,
  created_at: '2026-09-26T10:00:00Z',
  modified_at: null,
  label: price === METERED_PRICE ? 'Extra play' : 'Plus',
  amount,
  tax_amount: 0,
  proration: false,
  product_price_id: price,
  start_timestamp: null,
  end_timestamp: null,
})

/** An order: Plus bought for $15, no tax, unless patched. */
export const order = (externalId: string | null, patch: Partial<models.Order> = {}): models.Order => ({
  id: 'b1c4e2f0-6f1d-4a57-9e57-7c1f0f4d2a11',
  created_at: '2026-09-26T10:00:00Z',
  modified_at: null,
  status: 'paid',
  paid: true,
  subtotal_amount: 1500,
  discount_amount: 0,
  net_amount: 1500,
  tax_amount: 0,
  total_amount: 1500,
  applied_balance_amount: 0,
  due_amount: 0,
  refunded_amount: 0,
  refunded_tax_amount: 0,
  currency: 'usd',
  billing_reason: 'subscription_create',
  billing_name: null,
  billing_address: null,
  invoice_number: null,
  is_invoice_generated: false,
  receipt_number: null,
  units: null,
  customer_id: CUSTOMER,
  product_id: PLUS_PRODUCT,
  discount_id: null,
  subscription_id: 'e5149aae-e521-42b9-b24c-abb3d71eea2e',
  checkout_id: null,
  metadata: {},
  platform_fee_amount: 0,
  platform_fee_currency: null,
  customer: customer(externalId),
  product: null,
  discount: null,
  subscription: null,
  items: [],
  description: 'Plus',
  refundable_amount: 0,
  refundable_tax_amount: 0,
  ...patch,
})

/** A payment tried for an order, by card. */
export const payment = (order: string, status: models.PaymentStatus): models.Payment => ({
  id: `payment-${order}`,
  created_at: '2026-10-01T00:00:00Z',
  modified_at: null,
  processor: 'stripe',
  status,
  amount: 1500,
  currency: 'usd',
  method: 'card',
  trigger: 'subscription_cycle',
  decline_reason: status === 'failed' ? 'card_declined' : null,
  decline_message: status === 'failed' ? 'Your card was declined.' : null,
  organization_id: ORGANIZATION,
  checkout_id: null,
  order_id: order,
  method_metadata: { brand: 'visa', last4: '4242' },
})

/** A checkout made for a customer: open, an hour from now, for `amount` cents unless patched. */
export const checkout = (id: string, url: string, patch: Partial<models.Checkout> = {}): models.Checkout => ({
  id,
  created_at: new Date().toISOString(),
  modified_at: null,
  payment_processor: 'stripe',
  status: 'open',
  client_secret: `polar_c_${id}`,
  url,
  expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
  success_url: 'http://localhost:3000/account',
  return_url: 'http://localhost:3000/account',
  embed_origin: null,
  amount: 1500,
  units: null,
  min_units: null,
  max_units: null,
  discount_amount: 0,
  net_amount: 1500,
  tax_amount: null,
  tax_behavior: null,
  total_amount: 1500,
  currency: 'usd',
  allow_trial: null,
  active_trial_interval: null,
  active_trial_interval_count: null,
  trial_end: null,
  organization_id: ORGANIZATION,
  product_id: PLUS_PRODUCT,
  product_price_id: null,
  discount_id: null,
  allow_discount_codes: true,
  require_billing_address: false,
  is_discount_applicable: true,
  is_free_product_price: false,
  is_payment_required: true,
  is_payment_setup_required: false,
  is_payment_form_required: true,
  customer_id: null,
  is_business_customer: false,
  customer_name: null,
  customer_email: null,
  customer_ip_address: null,
  customer_billing_name: null,
  customer_billing_address: null,
  customer_tax_id: null,
  payment_method_type: null,
  payment_processor_metadata: {},
  billing_address_fields: {
    country: 'required',
    state: 'optional',
    city: 'optional',
    postal_code: 'optional',
    line1: 'optional',
    line2: 'optional',
  },
  trial_interval: null,
  trial_interval_count: null,
  metadata: {},
  external_customer_id: null,
  products: [],
  product: null,
  product_price: null,
  prices: null,
  discount: null,
  subscription_id: null,
  attached_custom_fields: null,
  customer_metadata: {},
  ...patch,
})

/** A session in the customer portal, opened at `url`. */
export const customerSession = (url: string): models.CustomerSession => ({
  id: 'b7e0c1d2-3f4a-4b5c-8d6e-7f8091a2b3c4',
  created_at: new Date().toISOString(),
  modified_at: null,
  token: 'polar_cst_test',
  expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
  return_url: 'http://localhost:3000/account',
  customer_portal_url: url,
  customer_id: CUSTOMER,
  customer: customer(null),
})

/** A refund asked for on an order: `amount` cents before tax, as a duplicate. */
export const refund = (id: string, order: string, amount: number): models.Refund => ({
  id,
  created_at: new Date().toISOString(),
  modified_at: null,
  metadata: {},
  status: 'pending',
  reason: 'duplicate',
  amount,
  tax_amount: 0,
  currency: 'usd',
  organization_id: ORGANIZATION,
  order_id: order,
  subscription_id: null,
  customer_id: CUSTOMER,
  revoke_benefits: false,
  dispute: null,
})

/** What Polar answers events taken with: each new one inserted, each sent before a duplicate. */
export const eventsIngested = (inserted: number, duplicates = 0): models.EventsIngestResponse => ({
  inserted,
  duplicates,
})

export type OrderEvent = Extract<webhooks.WebhookPayload, { data: models.Order }>
type SubscriptionEvent = Extract<webhooks.WebhookPayload, { data: models.Subscription }>

/** An order event: `order.paid` unless said otherwise. */
export const orderEvent = (data: models.Order, type: OrderEvent['type'] = 'order.paid'): OrderEvent => ({
  type,
  timestamp: new Date().toISOString(),
  api_version: API_VERSION,
  data,
})

/** A subscription event, of the kind `type` names. Each carries the subscription alike. */
export const subscriptionEvent = (
  data: models.Subscription,
  type: SubscriptionEvent['type'],
): Omit<SubscriptionEvent, 'type'> & Pick<SubscriptionEvent, 'type'> => ({
  type,
  timestamp: new Date().toISOString(),
  api_version: API_VERSION,
  data,
})

/** Polar's word that a customer's state changed, carrying the state (`StateSubscription` says why not the SDK's own). */
export const stateChanged = (data: CustomerState) => ({
  ...({
    type: 'customer.state_changed',
    timestamp: new Date().toISOString(),
    api_version: API_VERSION,
  } satisfies Omit<webhooks.WebhookCustomerStateChangedPayload, 'data'>),
  data,
})

/** A delivery signed the Standard Webhooks way: HMAC-SHA256 of "id.timestamp.body". */
export function signed(event: unknown, secret: string, at = new Date()) {
  const body = JSON.stringify(event)
  const id = `msg_${randomBytes(6).toString('hex')}`
  const timestamp = String(Math.floor(at.getTime() / 1000))
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')
  return {
    body,
    headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` },
  }
}

/**
 * Stands in for Polar's API: records every request and answers with `reply`, except a customer's
 * state, which it answers from `states` as Polar holds it now. `down`: Polar answers nothing.
 */
export class PolarStandIn {
  readonly requests: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = []
  /** Each customer's state now, by external id. */
  readonly states = new Map<string, CustomerState>()
  down = false
  reply: (request: { method: string; path: string; body: string }) => Answer = () => ({
    status: 200,
    body: {},
  })
  url = ''
  #server: Server | null = null

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        const seen = { method: request.method ?? '', path: request.url ?? '', headers: request.headers, body }
        this.requests.push(seen)
        const answer = this.down ? failing() : (this.#state(seen.path) ?? this.reply(seen))
        response.statusCode = answer.status
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(answer.body))
      })
    })
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
  }

  close(): void {
    this.#server?.close()
  }

  #state(path: string): Answer | null {
    const asked = /^\/v1\/customers\/external\/([^/]+)\/state$/.exec(path)?.[1]
    if (asked === undefined) return null
    const state = this.states.get(decodeURIComponent(asked))
    return state === undefined ? notFound : { status: 200, body: state }
  }
}
