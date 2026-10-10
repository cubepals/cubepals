/**
 * The control plane with the real Polar adapter against a stand-in for Polar's API, for tests of
 * what Polar's word does to an account: subscriptions, orders and their payments as Polar holds
 * them now, signed webhook deliveries of each, and the balance product. One per test file, started
 * in `beforeAll` and `reset` in `beforeEach`.
 *
 * It is not the stand-in itself (`polar.ts`), and holds no assertion.
 */
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { UserActor } from '../app/actor.ts'
import { PolarBilling } from '../infra/polar/polar-billing.ts'
import { createBillingWebhook } from '../interfaces/billing/webhook.ts'
import { type Harness, startHarness } from './harness.ts'
import {
  customerState,
  order,
  orderEvent,
  PLUS_PRODUCT,
  PolarStandIn,
  signed,
  stateChanged,
  subscription,
  webhookSecret,
} from './polar.ts'

const FIXED_PRICE = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c001'
const METERED_PRICE = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c002'
/** The one-time product a balance is paid with, found by its metadata. */
export const BALANCE = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c003'

type Answer = { status: number; body: unknown }
const notFound: Answer = { status: 404, body: { error: 'ResourceNotFound', detail: 'Not found' } }
const list = (items: unknown[]): Answer => ({
  status: 200,
  body: { items, pagination: { total_count: items.length, max_page: 1 } },
})

export class PolarWorld {
  readonly polar = new PolarStandIn()
  readonly #secret = webhookSecret()
  #h: Harness | null = null
  #webhook: ReturnType<typeof createBillingWebhook> | null = null
  /** Subscriptions, orders and checkouts as Polar holds them now, by id. */
  readonly subscriptions = new Map<string, Record<string, unknown>>()
  readonly orders = new Map<string, Record<string, unknown>>()
  readonly checkouts = new Map<string, Record<string, unknown>>()
  /** Orders with a payment that was tried and failed. */
  readonly declined = new Set<string>()
  /** Refunds asked for, as their request bodies. */
  readonly refunds: Array<Record<string, unknown>> = []

  get h(): Harness {
    if (this.#h === null) throw new Error('PolarWorld is not started')
    return this.#h
  }

  async start(): Promise<void> {
    await this.polar.start()
    const billing = new PolarBilling({
      accessToken: 'polar_oat_test',
      webhookSecret: this.#secret,
      server: 'sandbox',
      products: { plus: PLUS_PRODUCT },
      baseUrl: this.polar.url,
    })
    this.#h = await startHarness({ capabilities: { archives: null, billing } })
    this.#webhook = createBillingWebhook({ billing: this.#h.app.billing })
  }

  async close(): Promise<void> {
    await this.#h?.close()
    this.polar.close()
  }

  /** Polar answers from what it holds; anything else it doesn't know. */
  reset(): void {
    this.polar.reply = (request) => this.#answer(request.method, request.path, request.body)
  }

  #answer(method: string, path: string, body: string): Answer {
    const url = new URL(path, 'http://polar')
    const id = (prefix: string) =>
      url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null
    if (url.pathname === '/v1/products/') return list([{ id: BALANCE }])
    if (url.pathname.startsWith(`/v1/products/${PLUS_PRODUCT}`))
      return {
        status: 200,
        body: {
          id: PLUS_PRODUCT,
          prices: [
            { id: FIXED_PRICE, amount_type: 'fixed' },
            { id: METERED_PRICE, amount_type: 'metered_unit' },
          ],
        },
      }
    if (method === 'POST') return this.#write(url.pathname, body)
    if (url.pathname === '/v1/checkouts/') return this.#open(url)
    if (url.pathname.startsWith('/v1/payments'))
      return list(this.declined.has(url.searchParams.get('order_id') ?? '') ? [{ status: 'failed' }] : [])
    const sub = id('/v1/subscriptions/')
    if (sub !== null) return { status: 200, body: this.subscriptions.get(sub) ?? subscription(sub) }
    const held = this.orders.get(id('/v1/orders/') ?? '')
    return held === undefined ? notFound : { status: 200, body: held }
  }

  /** What is sent to Polar: a checkout made, events taken, a refund asked for. */
  #write(path: string, body: string): Answer {
    if (path === '/v1/checkouts/') return this.#checkout(body)
    if (path.startsWith('/v1/events/ingest'))
      return {
        status: 200,
        body: { inserted: (JSON.parse(body) as { events: unknown[] }).events.length, duplicates: 0 },
      }
    if (path !== '/v1/refunds/') return notFound
    this.refunds.push(JSON.parse(body) as Record<string, unknown>)
    return { status: 201, body: { id: `refund-${this.refunds.length}` } }
  }

  /** A checkout made: kept open, an hour from now, as Polar answers it. */
  #checkout(body: string): Answer {
    const asked = JSON.parse(body) as { prices?: Record<string, Array<{ price_amount?: number }>> }
    const made = {
      ...asked,
      amount: Object.values(asked.prices ?? {})[0]?.[0]?.price_amount ?? 0,
      id: `checkout-${this.checkouts.size + 1}`,
      url: `https://polar.test/checkout/${this.checkouts.size + 1}`,
      status: 'open',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }
    this.checkouts.set(made.id, made)
    return { status: 201, body: made }
  }

  /** Open checkouts for a customer, as `checkouts.list` filters them. */
  #open(url: URL): Answer {
    const customer = url.searchParams.get('external_customer_id')
    return list(
      [...this.checkouts.values()].filter(
        (c) => c.status === 'open' && (customer === null || c.external_customer_id === customer),
      ),
    )
  }

  post(event: unknown) {
    const delivery = signed(event, this.#secret)
    if (this.#webhook === null) throw new Error('PolarWorld is not started')
    return this.#webhook.request('/api/billing/webhook', {
      method: 'POST',
      body: delivery.body,
      headers: { 'content-type': 'application/json', ...delivery.headers },
    })
  }

  /** Polar's word on the account's subscription, as a customer state now and its delivery. */
  async standing(owner: UserActor, sub: string, patch: Record<string, unknown> = {}, paying = true) {
    const state = customerState(owner.userId, paying ? {} : { active_subscriptions: [] }, {
      id: sub,
      ...patch,
    })
    this.polar.states.set(owner.userId, state)
    await this.post(stateChanged(state))
  }

  /** The subscription as Polar holds it now, and its word that the customer's standing changed. */
  async subscriptionNow(owner: UserActor, sub: string, patch: Record<string, unknown>) {
    this.subscriptions.set(sub, subscription(sub, patch))
    await this.standing(owner, sub, {}, false)
  }

  /** An order as Polar holds it now, and its delivery; paid, for Plus alone, unless patched. */
  async ordered(
    owner: UserActor,
    sub: string | null,
    patch: Record<string, unknown> = {},
    type = 'order.paid',
  ) {
    const id = (patch.id as string | undefined) ?? `order-${randomUUID()}`
    const held = order(owner.userId, { subscription_id: sub, ...patch, id })
    this.orders.set(id, held)
    await this.post(orderEvent(held, type))
    return id
  }

  /** A new Plus subscriber, its first payment made. */
  async subscriber(name: string) {
    const owner = await this.h.user(name)
    const sub = randomUUID()
    await this.standing(owner, sub)
    await this.ordered(owner, sub, { created_at: new Date().toISOString() })
    return { owner, sub }
  }

  /**
   * A renewal with $2.50 of extra hours on its $17.50, `tax` on top, as Polar delivers it: made
   * and waiting, or voided.
   */
  renewalWithExtra(
    owner: UserActor,
    sub: string,
    madeAt: Date,
    options: { status?: string; id?: string; tax?: number } = {},
  ) {
    const status = options.status ?? 'pending'
    const tax = options.tax ?? 0
    return this.ordered(
      owner,
      sub,
      {
        ...(options.id === undefined ? {} : { id: options.id }),
        status,
        paid: false,
        billing_reason: 'subscription_cycle',
        created_at: madeAt.toISOString(),
        subtotal_amount: 1750,
        net_amount: 1750,
        tax_amount: tax,
        total_amount: 1750 + tax,
        items: [
          { amount: 1500, product_price_id: FIXED_PRICE },
          { amount: 250, product_price_id: METERED_PRICE },
        ],
      },
      status === 'pending' ? 'order.created' : 'order.updated',
    )
  }

  /** A one-time order of the balance product, paid for `net` before tax, naming `settles`. */
  paidBalance(owner: UserActor, settles: string, net: number, patch: Record<string, unknown> = {}) {
    return this.ordered(owner, null, {
      product_id: BALANCE,
      billing_reason: 'purchase',
      subtotal_amount: net,
      net_amount: net,
      tax_amount: 0,
      total_amount: net,
      metadata: { settles },
      ...patch,
    })
  }

  /** An order as Blockly keeps it. */
  async kept(externalOrderId: string) {
    const [row] = await this.h.db
      .select()
      .from(schema.billingOrders)
      .where(eq(schema.billingOrders.externalOrderId, externalOrderId))
    return row
  }

  /** What the account's audit log kept under `action`, oldest first. */
  async audited(owner: UserActor, action: string) {
    const rows = await this.h.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectId, owner.userId))
    return rows.filter((row) => row.action === action).map((row) => row.data)
  }

  /** The emails sent to the owner. */
  async mailTo(owner: UserActor) {
    const [user] = await this.h.db.select().from(schema.users).where(eq(schema.users.id, owner.userId))
    return this.h.mail.to(user?.email ?? '')
  }
}
