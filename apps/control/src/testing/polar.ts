// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** The Polar product that sells `plus` in tests. */
export const PLUS_PRODUCT = 'd8dd2de1-21b7-4a41-8bc3-ce909c0cfe23'

/** A webhook secret in Polar's format. */
export const webhookSecret = () => `whsec_${randomBytes(24).toString('base64')}`

/** A customer's state, shaped like API 2026-10's CustomerState, paying for plus unless patched. */
export const customerState = (
  externalId: string | null,
  patch: Record<string, unknown> = {},
  subscription: Record<string, unknown> = {},
) => ({
  id: '992fae2a-2a17-4b7a-8d9d-e45177024a7c',
  created_at: '2026-09-01T00:00:00Z',
  modified_at: null,
  metadata: {},
  external_id: externalId,
  email: 'player@example.com',
  email_verified: true,
  type: 'individual',
  name: null,
  organization_id: '1dbfc517-0bbf-4301-9ba8-555ca42b9737',
  deleted_at: null,
  active_subscriptions: [
    {
      id: 'e5149aae-e521-42b9-b24c-abb3d71eea2e',
      status: 'active',
      amount: 500,
      currency: 'usd',
      recurring_interval: 'month',
      current_period_start: '2026-09-01T00:00:00Z',
      current_period_end: '2099-10-01T00:00:00Z',
      cancel_at_period_end: false,
      product_id: PLUS_PRODUCT,
      metadata: {},
      ...subscription,
    },
  ],
  granted_benefits: [],
  active_meters: [],
  ...patch,
})

/**
 * A subscription, shaped like API 2026-10's Subscription (the fields a standing doesn't carry):
 * Plus, cancelled and ended, unless patched.
 */
export const subscription = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  created_at: '2026-09-01T00:00:00Z',
  modified_at: '2026-09-26T10:00:00Z',
  amount: 1500,
  currency: 'usd',
  recurring_interval: 'month',
  status: 'canceled',
  current_period_start: '2026-09-01T00:00:00Z',
  current_period_end: '2026-10-01T00:00:00Z',
  trial_start: null,
  trial_end: null,
  cancel_at_period_end: false,
  canceled_at: '2026-09-26T10:00:00Z',
  started_at: '2026-09-01T00:00:00Z',
  ends_at: null,
  ended_at: '2026-09-26T10:00:00Z',
  past_due_at: null,
  customer_id: '992fae2a-2a17-4b7a-8d9d-e45177024a7c',
  product_id: PLUS_PRODUCT,
  discount_id: null,
  checkout_id: null,
  metadata: {},
  ...patch,
})

/** An order, shaped like API 2026-10's Order: Plus bought for $15, no tax, unless patched. */
export const order = (externalId: string | null, patch: Record<string, unknown> = {}) => ({
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
  customer_id: '992fae2a-2a17-4b7a-8d9d-e45177024a7c',
  product_id: PLUS_PRODUCT,
  discount_id: null,
  subscription_id: 'e5149aae-e521-42b9-b24c-abb3d71eea2e',
  checkout_id: null,
  metadata: {},
  customer: {
    id: '992fae2a-2a17-4b7a-8d9d-e45177024a7c',
    external_id: externalId,
    email: 'player@example.com',
  },
  items: [],
  ...patch,
})

/** An order event: `order.paid` unless said otherwise. */
export const orderEvent = (data: unknown, type = 'order.paid') => ({
  type,
  timestamp: new Date().toISOString(),
  api_version: '2026-10',
  data,
})

export const stateChanged = (data: unknown) => ({
  type: 'customer.state_changed',
  timestamp: new Date().toISOString(),
  api_version: '2026-10',
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
  readonly states = new Map<string, unknown>()
  down = false
  reply: (request: { method: string; path: string; body: string }) => { status: number; body: unknown } =
    () => ({
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
        const answer = this.down
          ? { status: 503, body: { detail: 'maintenance' } }
          : (this.#state(seen.path) ?? this.reply(seen))
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

  #state(path: string): { status: number; body: unknown } | null {
    const asked = /^\/v1\/customers\/external\/([^/]+)\/state$/.exec(path)?.[1]
    if (asked === undefined) return null
    const state = this.states.get(decodeURIComponent(asked))
    return state === undefined
      ? { status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } }
      : { status: 200, body: state }
  }
}
