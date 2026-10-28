// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The control plane with the real Polar adapter against a stand-in for Polar's API, for tests of
 * what Polar's word does to an account: subscriptions, orders and their payments as Polar holds
 * them now (a revoke and an order's refunds among them), signed webhook deliveries of each, the
 * balance product and a year of Plus. One per test file, started in `beforeAll` and `reset` in
 * `beforeEach`.
 *
 * It is not the stand-in itself (`polar.ts`), and holds no assertion.
 */
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { UserActor } from '../app/actor.ts'
import { PolarBilling } from '../infra/polar/polar-billing.ts'
import type { models } from '../infra/polar/polar-models.ts'
import { createBillingWebhook } from '../interfaces/billing/webhook.ts'
import { type Harness, startHarness } from './harness.ts'
import {
  type Answer,
  CORE_FIXED_PRICE,
  CORE_METERED_PRICE,
  CORE_PRODUCT,
  checkout,
  customerState,
  eventsIngested,
  FIXED_PRICE,
  METERED_PRICE,
  notFound,
  type OrderEvent,
  order,
  orderEvent,
  orderItem,
  PLUS_PRODUCT,
  PolarStandIn,
  page,
  payment,
  product,
  refund,
  type StateSubscription,
  signed,
  stateChanged,
  subscription,
  webhookSecret,
} from './polar.ts'

/** The one-time product a balance is paid with, found by its metadata. */
export const BALANCE = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c003'
/** The one-time product that sells a year of Plus, found by its metadata. */
export const YEAR = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c004'
/** The one-time product friends chip in to a server with, found by its metadata. */
export const CHIP_IN = '0f6f9a52-3b8c-4d0e-9a51-1f0ab2a1c005'

/** The rest of a pending update Polar holds. */
const PENDING = { id: 'pending-update', created_at: '2026-10-01T00:00:00Z', modified_at: null, seats: null }

const list = (items: unknown[]): Answer => ({ status: 200, body: page(items) })

/** What is asked of a subscription: a cancel at the period's end, or another product from the next. */
type SubscriptionChange = models.SubscriptionUpdateBase & { cancel_at_period_end?: boolean }

export class PolarWorld {
  /** The products it sells: both paid plans, or the ones a test names. */
  readonly #products: Record<string, string>
  /** The Polar adapter the control plane runs on, once started. */
  billing: PolarBilling | null = null
  /** Products at an early price Polar holds, archived ones too (`earlyProduct` in `polar.ts`). */
  readonly early: models.Product[] = []

  constructor(products: Record<string, string> = { core: CORE_PRODUCT, plus: PLUS_PRODUCT }) {
    this.#products = products
  }

  readonly polar = new PolarStandIn()
  readonly #secret = webhookSecret()
  #h: Harness | null = null
  #webhook: ReturnType<typeof createBillingWebhook> | null = null
  /** Subscriptions and orders as Polar holds them now, by id. */
  readonly subscriptions = new Map<string, models.Subscription>()
  readonly orders = new Map<string, models.Order>()
  /** Checkouts as Polar holds them now, by id, each with what it was asked for. */
  readonly checkouts = new Map<string, { asked: models.CheckoutCreate; made: models.Checkout }>()
  /** Orders with a payment that was tried and failed. */
  readonly declined = new Set<string>()
  /** Refunds asked for, as their request bodies. */
  readonly refunds: models.RefundCreate[] = []
  /** Changes asked of a subscription (a cancel at the period's end), as their request bodies, by id. */
  readonly updates: Array<{ id: string; body: SubscriptionChange }> = []

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
      products: this.#products,
      baseUrl: this.polar.url,
    })
    this.billing = billing
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
    if (url.pathname === '/v1/products/') return this.#found(url)
    const plan = [PLUS_PRODUCT, CORE_PRODUCT].find((each) => url.pathname.startsWith(`/v1/products/${each}`))
    if (plan !== undefined) return { status: 200, body: product(plan) }
    const early = this.early.find((each) => url.pathname.startsWith(`/v1/products/${each.id}`))
    if (early !== undefined) return { status: 200, body: early }
    if (method === 'POST') return this.#write(url.pathname, body)
    if (url.pathname === '/v1/checkouts/') return this.#open(url)
    if (url.pathname === '/v1/refunds/') {
      const asked = url.searchParams.get('order_id')
      return list(
        this.refunds
          .filter((r) => r.order_id === asked)
          .map((r, i) => ({ ...refund(`refund-${i + 1}`, r.order_id, r.amount), reason: r.reason })),
      )
    }
    if (url.pathname.startsWith('/v1/payments')) {
      const asked = url.searchParams.get('order_id') ?? ''
      return list(this.declined.has(asked) ? [payment(asked, 'failed')] : [])
    }
    const sub = id('/v1/subscriptions/')
    if (sub !== null) return this.#subscription(method, sub, body)
    const held = this.orders.get(id('/v1/orders/') ?? '')
    return held === undefined ? notFound : { status: 200, body: held }
  }

  /** A subscription read, revoked or changed. */
  #subscription(method: string, sub: string, body: string): Answer {
    if (method === 'DELETE') return this.#revoke(sub)
    if (method === 'PATCH') return this.#update(sub, body)
    return { status: 200, body: this.subscriptions.get(sub) ?? subscription(sub) }
  }

  /** A change to a subscription kept as it was asked, and answered with the subscription as it is now. */
  #update(sub: string, body: string): Answer {
    const asked = JSON.parse(body) as SubscriptionChange
    this.updates.push({ id: sub, body: asked })
    const held = this.subscriptions.get(sub) ?? subscription(sub, { status: 'active', ended_at: null })
    // Polar changes the product of no subscription that is set to end with its period.
    if (asked.product_id != null && held.cancel_at_period_end)
      return {
        status: 403,
        body: {
          error: 'NotPermitted',
          detail: 'This subscription is already canceled or will be at the end of the period.',
        },
      }
    // A product change for the next period is held as the pending update, as Polar answers it.
    const later = asked.product_id != null && asked.proration_behavior === 'next_period'
    const updated = {
      ...held,
      ...(later
        ? {
            pending_update: {
              ...PENDING,
              applies_at: held.current_period_end ?? '',
              product_id: asked.product_id,
            },
          }
        : asked),
    } as models.Subscription
    this.subscriptions.set(sub, updated)
    this.#listed(sub, asked, later)
    return { status: 200, body: updated }
  }

  /** What the customer's state lists of a subscription changes with it: its product now, or whether it renews. */
  #listed(sub: string, asked: SubscriptionChange, later: boolean) {
    for (const state of this.polar.states.values())
      for (const listed of state.active_subscriptions)
        if (listed.id === sub) {
          if (asked.product_id != null && !later) listed.product_id = asked.product_id
          if (asked.cancel_at_period_end != null) listed.cancel_at_period_end = asked.cancel_at_period_end
        }
  }

  /** A subscription revoked: it ends now, as Polar answers it; one revoked already is refused. */
  #revoke(sub: string): Answer {
    const held = this.subscriptions.get(sub) ?? subscription(sub, { status: 'active', ended_at: null })
    if (held.ended_at !== null)
      return { status: 403, body: { error: 'AlreadyCanceledSubscription', detail: 'already revoked' } }
    const now = new Date().toISOString()
    const revoked = {
      ...held,
      status: 'canceled' as const,
      canceled_at: now,
      ended_at: now,
      past_due_at: null,
    }
    this.subscriptions.set(sub, revoked)
    return { status: 200, body: revoked }
  }

  /** One-time products, found by their metadata, which the query names. */
  #found(url: URL): Answer {
    if (url.searchParams.get('metadata[terms]') === 'early') return list(this.early)
    if (url.searchParams.get('metadata[term]') === 'year')
      return list([product(YEAR, { name: 'Plus, a year', metadata: { plan: 'plus', term: 'year' } })])
    if (url.searchParams.get('metadata[purpose]') === 'chip_in') return list([product(CHIP_IN)])
    return list([product(BALANCE)])
  }

  /** What is sent to Polar: a checkout made, events taken, a refund asked for. */
  #write(path: string, body: string): Answer {
    if (path === '/v1/checkouts/') return this.#checkout(body)
    if (path.startsWith('/v1/events/ingest'))
      return { status: 200, body: eventsIngested((JSON.parse(body) as models.EventsIngest).events.length) }
    if (path !== '/v1/refunds/') return notFound
    const asked = JSON.parse(body) as models.RefundCreate
    this.refunds.push(asked)
    return { status: 201, body: refund(`refund-${this.refunds.length}`, asked.order_id, asked.amount) }
  }

  /** A checkout made: kept open, an hour from now, as Polar answers it. */
  #checkout(body: string): Answer {
    const asked = JSON.parse(body) as models.CheckoutCreate
    const price = Object.values(asked.prices ?? {})[0]?.[0]
    const n = this.checkouts.size + 1
    const made = checkout(`checkout-${n}`, `https://polar.test/checkout/${n}`, {
      amount: price !== undefined && 'price_amount' in price ? price.price_amount : 0,
      metadata: asked.metadata ?? {},
      external_customer_id: asked.external_customer_id ?? null,
    })
    this.checkouts.set(made.id, { asked, made })
    return { status: 201, body: made }
  }

  /** Open checkouts for a customer, as `checkouts.list` filters them. */
  #open(url: URL): Answer {
    const customer = url.searchParams.get('external_customer_id')
    return list(
      [...this.checkouts.values()]
        .map((c) => c.made)
        .filter((c) => c.status === 'open' && (customer === null || c.external_customer_id === customer)),
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

  /**
   * When its subscriptions were made: a minute into the month the world was made in, so the month a
   * test counts in has nothing carried into it from an earlier month of Plus, and the runs a test
   * writes earlier this month were played on Plus.
   */
  readonly #made = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) + MINUTE_MS,
  ).toISOString()

  /** Polar's word on the account's subscription, as a customer state now and its delivery. */
  async standing(owner: UserActor, sub: string, patch: Partial<StateSubscription> = {}, paying = true) {
    const state = customerState(owner.userId, paying ? {} : { active_subscriptions: [] }, {
      id: sub,
      created_at: this.#made,
      ...patch,
    })
    this.polar.states.set(owner.userId, state)
    await this.post(stateChanged(state))
  }

  /** The subscription as Polar holds it now, and its word that the customer's standing changed. */
  async subscriptionNow(owner: UserActor, sub: string, patch: Partial<models.Subscription>) {
    this.subscriptions.set(sub, subscription(sub, patch))
    await this.standing(owner, sub, {}, false)
  }

  /** An order as Polar holds it now, and its delivery; paid, for Plus alone, unless patched. */
  async ordered(
    owner: UserActor,
    sub: string | null,
    patch: Partial<models.Order> = {},
    type: OrderEvent['type'] = 'order.paid',
  ) {
    const id = patch.id ?? `order-${randomUUID()}`
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
   * A renewal with $2.50 of extra hours on its $17.50 ($12.49 on Core), `tax` on top, as Polar delivers it: made
   * and waiting, or voided.
   */
  renewalWithExtra(
    owner: UserActor,
    sub: string,
    madeAt: Date,
    options: { status?: models.OrderStatus; id?: string; tax?: number; core?: boolean } = {},
  ) {
    const status = options.status ?? 'pending'
    const tax = options.tax ?? 0
    const net = options.core ? 1249 : 1750
    return this.ordered(
      owner,
      sub,
      {
        ...(options.id === undefined ? {} : { id: options.id }),
        status,
        paid: false,
        billing_reason: 'subscription_cycle',
        created_at: madeAt.toISOString(),
        subtotal_amount: net,
        net_amount: net,
        tax_amount: tax,
        total_amount: net + tax,
        ...(options.core ? { product_id: CORE_PRODUCT } : {}),
        items: options.core
          ? [orderItem(999, CORE_FIXED_PRICE), orderItem(250, CORE_METERED_PRICE)]
          : [orderItem(1500, FIXED_PRICE), orderItem(250, METERED_PRICE)],
      },
      status === 'pending' ? 'order.created' : 'order.updated',
    )
  }

  /** A one-time order of the balance product, paid for `net` before tax, naming `settles`. */
  paidBalance(owner: UserActor, settles: string, net: number, patch: Partial<models.Order> = {}) {
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

  /** A one-time order of the chip-in product, paid for `cents` with tax included, for `server`. */
  chippedIn(payer: UserActor, server: string, cents: number, patch: Partial<models.Order> = {}) {
    return this.ordered(payer, null, {
      product_id: CHIP_IN,
      billing_reason: 'purchase',
      subtotal_amount: cents,
      net_amount: cents,
      tax_amount: 0,
      total_amount: cents,
      metadata: { server },
      ...patch,
    })
  }

  /** A year of Plus paid at once, for $150 before tax unless patched: one order, no subscription. */
  paidYear(owner: UserActor, patch: Partial<models.Order> = {}) {
    return this.ordered(owner, null, {
      product_id: YEAR,
      billing_reason: 'purchase',
      subtotal_amount: 15000,
      net_amount: 15000,
      tax_amount: 0,
      total_amount: 15000,
      items: [],
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
