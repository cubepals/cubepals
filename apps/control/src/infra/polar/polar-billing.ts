import { PolarClientError, PolarError, PolarRateLimitError } from '@polar-sh/sdk'
import { createPolar, webhooks } from '@polar-sh/sdk/2026-10'
import { z } from 'zod'
import {
  type BillingEvent,
  type BillingOrder,
  type BillingProvider,
  type BillingState,
  BillingUnavailable,
  type OrderNow,
  type UsageEvent,
  WebhookRejected,
} from '../../app/ports/optional.ts'

/**
 * Polar through its official TypeScript SDK, pinned to API version 2026-10 for requests and for
 * webhook payloads (docs/dependency-audit.md). Customers carry our user id as their external id,
 * so nothing maps Polar's own ids back to users. A plan is a product; configuration says which.
 * Extra play is sent as `play.extra` events, which the "Extra play" meter sums and the plan's
 * metered price bills on its next payment; no id of either is configured.
 */

/** The event name the "Extra play" meter counts (docs/configuration.md, Polar). */
const EXTRA_PLAY_EVENT = 'play.extra'

export interface PolarBillingOptions {
  accessToken: string
  webhookSecret: string
  server: 'sandbox' | 'production'
  /** Plan key → the Polar product that sells it. */
  products: Readonly<Record<string, string>>
  /** Tests point this at a stand-in for Polar. */
  baseUrl?: string
}

// validateEvent checks the signature and the event type, not the payload (checked 2026-09-19),
// so the fields read here are checked on the way in.
const CustomerState = z.object({
  id: z.string(),
  external_id: z.string().nullish(),
  active_subscriptions: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['active', 'trialing']),
      product_id: z.string(),
      current_period_end: z.string(),
      cancel_at_period_end: z.boolean(),
      created_at: z.string().nullish(),
    }),
  ),
})

// A subscription event carries the subscription, and its customer the external id.
const SubscriptionEvent = z.object({ customer: z.object({ external_id: z.string().nullish() }) })

// Products found by their metadata: the one a balance is settled with.
const Products = z.object({ items: z.array(z.object({ id: z.string() })) })

// The prices of a plan's product, to tell the metered line of an order from the plan's own.
const Product = z.object({ prices: z.array(z.object({ id: z.string(), amount_type: z.string().nullish() })) })

// Checkouts still open, to offer one again rather than make a second.
const OpenCheckouts = z.object({
  items: z.array(
    z.object({
      url: z.string(),
      amount: z.number().nullish(),
      expires_at: z.string(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
    }),
  ),
})

/** An open checkout is offered again only with this long left on it, to be paid in. */
const CHECKOUT_LEFT_MS = 15 * 60_000

// Payments tried for an order: one that failed says its charge was tried and declined.
const Payments = z.object({ items: z.array(z.object({ status: z.string() })) })

// A customer state lists only subscriptions that pay now, `active` or `trialing` (Polar's
// `SubscriptionStatus.active_statuses`, read 2026-09-26); one whose renewal failed is `past_due`
// on the subscription itself while Polar retries the charge.
const Subscription = z.object({
  status: z.string(),
  current_period_end: z.string().nullish(),
  past_due_at: z.string().nullish(),
})

// The fields of Polar's `Order` (SDK 2026-10 `models`, read 2026-10-10) that revenue and extra play
// need: every amount is in cents, the customer carries the external id Blockly gave it, and each
// line names the price it charged, which says whether it is the metered one.
const Order = z.object({
  status: z.string(),
  subscription_id: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  items: z.array(z.object({ amount: z.number().int(), product_price_id: z.string().nullish() })).default([]),
  id: z.string(),
  created_at: z.string(),
  subtotal_amount: z.number().int(),
  discount_amount: z.number().int(),
  net_amount: z.number().int(),
  tax_amount: z.number().int(),
  total_amount: z.number().int(),
  refunded_amount: z.number().int(),
  currency: z.string(),
  billing_reason: z.string(),
  product_id: z.string().nullish(),
  customer: z.object({ external_id: z.string().nullish() }),
})

export class PolarBilling implements BillingProvider {
  readonly provider = 'polar'
  readonly #polar: ReturnType<typeof createPolar>
  readonly #webhookSecret: string
  readonly #products: Readonly<Record<string, string>>
  /** Product → plan. */
  readonly #plans: ReadonlyMap<string, string>
  /** Product → its prices, by id, with whether each is metered; read from Polar once each. */
  readonly #prices = new Map<string, Map<string, boolean>>()
  /** The one-time product a balance is settled with, found by its metadata once. */
  #balance: string | null = null

  constructor(options: PolarBillingOptions) {
    this.#polar = createPolar({
      accessToken: options.accessToken,
      environment: options.server,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    })
    this.#webhookSecret = options.webhookSecret
    this.#products = options.products
    this.#plans = new Map(Object.entries(options.products).map(([plan, product]) => [product, plan]))
  }

  async checkoutUrl(input: {
    userId: string
    email: string
    planKey: string
    returnUrl: string
  }): Promise<string> {
    const product = this.#products[input.planKey]
    if (product === undefined) throw new Error(`No Polar product sells the ${input.planKey} plan`)
    const checkout = await withEmail(input.email, (email) =>
      call('starting a checkout', () =>
        this.#polar.checkouts.create({
          products: [product],
          external_customer_id: input.userId,
          ...email,
          success_url: input.returnUrl,
          return_url: input.returnUrl,
        }),
      ),
    )
    return checkout.url
  }

  /**
   * A checkout for the "balance" product (metadata `purpose: balance`, one-time, any price) at
   * exactly what is owed before tax, as an ad-hoc price with tax on top, naming the orders it
   * settles in its metadata. Polar
   * no longer retries a renewal once its subscription has ended, and voids it; this is how that
   * money is paid (seen in the sandbox, 2026-10-10).
   */
  async settleUrl(input: {
    userId: string
    email: string
    cents: number
    settles: readonly string[]
    returnUrl: string
  }): Promise<string> {
    const product = await this.#balanceProduct()
    if (product === null) throw new Error('No Polar product has the metadata purpose: balance')
    // One still open for the same orders and amount is the one to pay: a second would be paid twice.
    const open = OpenCheckouts.parse(
      await call('finding an open payment', () =>
        this.#polar.checkouts.list({
          product_id: product,
          external_customer_id: input.userId,
          status: 'open',
          limit: 20,
        }),
      ),
    ).items.find(
      (checkout) =>
        checkout.metadata?.settles === input.settles.join(',') &&
        checkout.amount === input.cents &&
        new Date(checkout.expires_at).getTime() > Date.now() + CHECKOUT_LEFT_MS,
    )
    if (open !== undefined) return open.url
    const checkout = await withEmail(input.email, (email) =>
      call('starting a payment', () =>
        this.#polar.checkouts.create({
          products: [product],
          // Priced before tax, with tax added on top at the payer's rate: what the orders it
          // settles came to with their tax, never tax twice.
          prices: {
            [product]: [
              {
                amount_type: 'fixed',
                price_amount: input.cents,
                price_currency: 'usd',
                tax_behavior: 'exclusive',
              },
            ],
          },
          metadata: { settles: input.settles.join(',') },
          // A code would let less than what is owed clear it.
          allow_discount_codes: false,
          external_customer_id: input.userId,
          ...email,
          success_url: input.returnUrl,
          return_url: input.returnUrl,
        }),
      ),
    )
    return checkout.url
  }

  /** The one-time product a balance is settled with (metadata `purpose: balance`), read once. */
  async #balanceProduct(): Promise<string | null> {
    if (this.#balance === null) {
      const found = await call('finding the balance product', () =>
        this.#polar.products.list({ metadata: { purpose: 'balance' }, is_archived: false }),
      )
      this.#balance = Products.parse(found).items[0]?.id ?? null
    }
    return this.#balance
  }

  async portalUrl(input: { userId: string; returnUrl: string }): Promise<string> {
    const session = await call('opening the customer portal', () =>
      this.#polar.customerSessions.create({
        external_customer_id: input.userId,
        return_url: input.returnUrl,
      }),
    )
    return session.customer_portal_url
  }

  /**
   * Only `customer.state_changed` reports standing. A delivery carries the state as it was when it
   * was sent, and Polar sends a delivery that wasn't taken again, unchanged, later: a retry of an
   * older state can arrive after a newer one. So it only says whose standing changed, and the
   * standing is read from Polar now. `order.paid` and `order.refunded` carry the whole order,
   * which is what revenue is kept from. Events this API version doesn't know are not ours to read.
   */
  async receive(body: string, headers: Readonly<Record<string, string>>): Promise<BillingEvent | null> {
    let event: Awaited<ReturnType<typeof webhooks.validateEvent>>
    try {
      event = await webhooks.validateEvent(body, { ...headers }, this.#webhookSecret)
    } catch (error) {
      if (error instanceof webhooks.PolarWebhookUnknownTypeError) return null
      if (error instanceof webhooks.PolarWebhookError) throw new WebhookRejected(error.message)
      throw error
    }
    if (ORDER_EVENTS.has(event.type)) return { kind: 'order', order: await this.#order(event.data) }
    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      const userId = SubscriptionEvent.parse(event.data).customer.external_id
      if (!userId) return null
      return {
        kind: 'standing',
        state: (await this.stateOf(userId)) ?? { userId, externalCustomerId: '', subscription: null },
      }
    }
    if (event.type !== 'customer.state_changed') return null
    const sent = this.#standing(event.data)
    if (sent === null) return null
    // A customer Polar no longer has pays for nothing.
    return { kind: 'standing', state: (await this.stateOf(sent.userId)) ?? { ...sent, subscription: null } }
  }

  async #order(data: unknown): Promise<BillingOrder> {
    const order = Order.parse(data)
    let extraCents = 0
    for (const item of order.items)
      if (
        item.product_price_id &&
        order.product_id &&
        (await this.#metered(order.product_id, item.product_price_id))
      )
        extraCents += item.amount
    const settles = String(order.metadata?.settles ?? '')
      .split(',')
      .filter((id) => id.length > 0)
    // Only an order for the balance product pays for others: metadata on anything else is not ours.
    const balance =
      settles.length > 0 &&
      !!order.product_id &&
      !this.#plans.has(order.product_id) &&
      order.product_id === (await this.#balanceProduct())
    return {
      externalOrderId: order.id,
      userId: order.customer.external_id ?? null,
      planKey: order.product_id ? (this.#plans.get(order.product_id) ?? null) : null,
      billingReason: order.billing_reason,
      currency: order.currency,
      subtotalCents: order.subtotal_amount,
      discountCents: order.discount_amount,
      netCents: order.net_amount,
      taxCents: order.tax_amount,
      totalCents: order.total_amount,
      refundedCents: order.refunded_amount,
      status: order.status,
      extraCents,
      externalSubscriptionId: order.subscription_id ?? null,
      settles,
      balance,
      orderedAt: new Date(order.created_at),
    }
  }

  /**
   * Whether a price of a plan's product is metered. A product no plan names has nothing metered
   * Blockly reports; a price it doesn't know yet (one added since) has the product read again.
   */
  async #metered(productId: string, priceId: string): Promise<boolean> {
    if (!this.#plans.has(productId)) return false
    let prices = this.#prices.get(productId)
    if (prices === undefined || !prices.has(priceId)) {
      const product = Product.parse(
        await call('reading a product', () => this.#polar.products.get(productId)),
      )
      prices = new Map(
        product.prices.map((price) => [price.id, price.amount_type?.startsWith('metered') ?? false]),
      )
      this.#prices.set(productId, prices)
    }
    return prices.get(priceId) ?? false
  }

  /**
   * Extra play as `play.extra` events, `hours` in their metadata, each under its own id: Polar
   * keeps an id for good and counts one sent again as a duplicate, never twice. It bills an event
   * on the payment after it *receives* it, so these go as soon as they are counted.
   */
  async reportUsage(events: readonly UsageEvent[]): Promise<void> {
    if (events.length === 0) return
    await call('reporting extra play', () =>
      this.#polar.events.ingest({
        events: events.map((event) => ({
          name: EXTRA_PLAY_EVENT,
          external_customer_id: event.userId,
          external_id: event.externalId,
          timestamp: event.at.toISOString(),
          metadata: { hours: event.hours },
        })),
      }),
    )
  }

  /**
   * The order as Polar holds it now, with whether a payment for it failed: Polar keeps each try at
   * its charge as a payment, and one `failed` is a card that was declined (seen in the sandbox,
   * 2026-10-10, on a renewal of a subscription that then ended and was voided).
   */
  async order(externalOrderId: string): Promise<OrderNow | null> {
    try {
      const data = await call('reading an order', () => this.#polar.orders.get(externalOrderId))
      const failed = Payments.parse(
        await call('reading an order’s payments', () =>
          this.#polar.payments.list({ order_id: externalOrderId, status: 'failed', limit: 1 }),
        ),
      )
      return { order: await this.#order(data), chargeFailed: failed.items.length > 0 }
    } catch (error) {
      if (error instanceof PolarClientError && error.statusCode === 404) return null
      throw error
    }
  }

  /** A refund through Polar, which takes the amount before tax and refunds the tax on it with it. */
  async refund(input: { externalOrderId: string; cents: number; why: string }): Promise<void> {
    await call('refunding an order', () =>
      this.#polar.refunds.create({
        order_id: input.externalOrderId,
        amount: input.cents,
        reason: 'duplicate',
        comment: input.why,
      }),
    )
  }

  async stateOf(userId: string): Promise<BillingState | null> {
    try {
      return this.#standing(
        await call('reading a customer', () => this.#polar.customers.getStateExternal(userId)),
      )
    } catch (error) {
      if (error instanceof PolarClientError && error.statusCode === 404) return null
      throw error
    }
  }

  async pastDueSince(externalSubscriptionId: string): Promise<Date | null> {
    try {
      const subscription = Subscription.parse(
        await call('reading a subscription', () => this.#polar.subscriptions.get(externalSubscriptionId)),
      )
      if (subscription.status !== 'past_due') return null
      // The charge that failed was the renewal at the end of its period.
      const since = subscription.past_due_at ?? subscription.current_period_end
      return since ? new Date(since) : new Date()
    } catch (error) {
      if (error instanceof PolarClientError && error.statusCode === 404) return null
      throw error
    }
  }

  /**
   * A customer Blockly didn't create has no external id and isn't anyone's standing. A
   * subscription to a product no plan names grants nothing.
   */
  #standing(data: unknown): BillingState | null {
    const state = CustomerState.parse(data)
    if (!state.external_id) return null
    const paid = state.active_subscriptions.find((subscription) => this.#plans.has(subscription.product_id))
    return {
      userId: state.external_id,
      externalCustomerId: state.id,
      subscription:
        paid === undefined
          ? null
          : {
              externalSubscriptionId: paid.id,
              planKey: this.#plans.get(paid.product_id) ?? '',
              status: paid.status,
              currentPeriodEnd: new Date(paid.current_period_end),
              cancelAtPeriodEnd: paid.cancel_at_period_end,
              ...(paid.created_at ? { createdAt: new Date(paid.created_at) } : {}),
            },
    }
  }
}

/**
 * Deliveries that carry a whole order: one made (a renewal is made `pending`, then paid or not),
 * changed, paid or refunded. Each says the order as it is, so the newest word wins.
 */
const ORDER_EVENTS: ReadonlySet<string> = new Set([
  'order.created',
  'order.updated',
  'order.paid',
  'order.refunded',
])

/**
 * Deliveries that say a subscription changed in a way extra play turns on: past due, cancelled,
 * cancelled no more, ended, or active again. Like a customer's state, each only says whose
 * standing to read from Polar now.
 */
const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  'subscription.past_due',
  'subscription.canceled',
  'subscription.uncanceled',
  'subscription.revoked',
  'subscription.active',
])

/**
 * Polar refused the request for the customer's email address. It checks a checkout against each
 * shape one could take and reports every one that failed, so the address is one problem among
 * several; asked again without it, anything else still wrong is refused again.
 */
function refusesEmail(error: unknown): boolean {
  if (!(error instanceof PolarClientError) || error.statusCode !== 422) return false
  const detail = (error.error as { detail?: Array<{ loc?: unknown[] }> } | null)?.detail ?? []
  return detail.some((problem) => problem.loc?.includes('customer_email'))
}

/**
 * A checkout made with the customer's email, or without it when Polar won't take the address (one
 * on a reserved domain, as test accounts have): that isn't the person's to fix, so the checkout
 * opens without it and asks them for one.
 */
function withEmail<T>(email: string, create: (field: { customer_email?: string }) => Promise<T>): Promise<T> {
  return create({ customer_email: email }).catch((error: unknown) => {
    if (refusesEmail(error)) return create({})
    throw error
  })
}

/** Polar's outage, rate limit or an unreachable network is billing being unavailable. */
async function call<T>(what: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    const unavailable =
      error instanceof PolarRateLimitError ||
      (error instanceof PolarError && !(error instanceof PolarClientError))
    if (unavailable) throw new BillingUnavailable(`${what}: ${(error as Error).message}`)
    throw error
  }
}
