// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { BillingTerm } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { PolarClientError } from '@polar-sh/sdk'
import { createPolar, errors, type models, webhooks } from '@polar-sh/sdk/2026-10'
import { z } from 'zod'
import {
  type BillingEvent,
  type BillingOrder,
  type BillingProvider,
  type BillingState,
  type Discount,
  DiscountRefused,
  type GiftProduct,
  type NewDiscount,
  type OrderNow,
  type UsageEvent,
  WebhookRejected,
} from '../../app/ports/optional.ts'
import { discountBody, discountOf } from './polar-discounts.ts'
import { GIFT_METADATA, giftOf } from './polar-gifts.ts'
import type { Fields } from './polar-models.ts'
import { call, refusal } from './polar-requests.ts'

/**
 * Polar through its official TypeScript SDK, pinned to API version 2026-10 for requests and for
 * webhook payloads (docs/dependency-audit.md). Customers carry our user id as their external id,
 * so nothing maps Polar's own ids back to users. A plan is a product; configuration says which.
 * A year of a plan is a one-time product found by its metadata (`plan`, `term: year`): Polar has
 * no subscription that ends rather than renewing, so the year is Blockly's to keep (`plan_years`).
 * Extra play is sent as `play.extra` events, which the "Extra play" meter sums and the plan's
 * metered price bills on its next payment; no id of either is configured. Gifts are one-time
 * products found by their metadata (`polar-gifts.ts`).
 */

/** The event name the "Extra play" meter counts (docs/configuration.md, Polar). */
const EXTRA_PLAY_EVENT = 'play.extra'

/** The metadata `purpose` of the one-time product friends chip in to a server with. */
const CHIP_IN = 'chip_in'

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
// so the fields read here are checked on the way in, each by the SDK's name for it (`Fields`).
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
      canceled_at: z.string().nullish(),
    } satisfies Fields<models.CustomerStateSubscription>),
  ),
} satisfies Fields<models.CustomerStateIndividual>)

// A subscription event carries the subscription, and its customer the external id.
const SubscriptionEvent = z.object({
  customer: z.object({ external_id: z.string().nullish() } satisfies Fields<models.SubscriptionCustomer>),
} satisfies Fields<models.Subscription>)

// Products found by their metadata: the one a balance is settled with, the one friends chip in
// with, and each plan's year.
const Products = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    } satisfies Fields<models.Product>),
  ),
} satisfies Fields<models.ListResourceProduct>)

// A page of products read whole, each by whoever reads it (`giftOf`).
const Listed = z.object({ items: z.array(z.unknown()) } satisfies Fields<models.ListResourceProduct>)

// The prices of a plan's product, to tell the metered line of an order from the plan's own.
const Product = z.object({
  prices: z.array(
    z.object({ id: z.string(), amount_type: z.string().nullish() } satisfies Fields<models.ProductPrice>),
  ),
} satisfies Fields<models.Product>)

// Checkouts still open, to offer one again rather than make a second.
const OpenCheckouts = z.object({
  items: z.array(
    z.object({
      url: z.string(),
      amount: z.number().nullish(),
      expires_at: z.string(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
    } satisfies Fields<models.Checkout>),
  ),
} satisfies Fields<models.ListResourceCheckout>)

/** An open checkout is offered again only with this long left on it, to be paid in. */
const CHECKOUT_LEFT_MS = 15 * MINUTE_MS

// A page of discounts: each is read by `discountOf`, and `max_page` says when to stop.
const DiscountPage = z.object({
  items: z.array(z.unknown()),
  pagination: z.object({ max_page: z.number().int() } satisfies Fields<models.Pagination>),
} satisfies Fields<models.ListResourceDiscount>)

// Payments tried for an order: one that failed says its charge was tried and declined.
const Payments = z.object({
  items: z.array(z.object({ status: z.string() } satisfies Fields<models.Payment>)),
} satisfies Fields<models.ListResourcePayment>)

// A customer state lists only subscriptions that pay now, `active` or `trialing` (Polar's
// `SubscriptionStatus.active_statuses`, read 2026-09-26); one whose renewal failed is `past_due`
// on the subscription itself while Polar retries the charge.
const Subscription = z.object({
  status: z.string(),
  current_period_end: z.string().nullish(),
  past_due_at: z.string().nullish(),
} satisfies Fields<models.Subscription>)

// An order's refunds, each with the reason it was given for.
const Refunds = z.object({
  items: z.array(z.object({ reason: z.string() } satisfies Fields<models.Refund>)),
} satisfies Fields<models.ListResourceRefund>)

/**
 * The refund reason a withdrawal is given in Polar: the player asked for their money back.
 * Blockly's own refunds (`refund`) are `duplicate`.
 */
const WITHDRAWAL_REASON: models.RefundReason = 'customer_request'

// The fields of Polar's `Order` (SDK 2026-10 `models`, read 2026-10-10) that revenue and extra play
// need: every amount is in cents, the customer carries the external id Blockly gave it, and each
// line names the price it charged, which says whether it is the metered one.
const Order = z.object({
  status: z.string(),
  subscription_id: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  items: z
    .array(
      z.object({
        amount: z.number().int(),
        product_price_id: z.string().nullish(),
      } satisfies Fields<models.OrderItemSchema>),
    )
    .default([]),
  id: z.string(),
  created_at: z.string(),
  modified_at: z.string().nullish(),
  subtotal_amount: z.number().int(),
  discount_amount: z.number().int(),
  net_amount: z.number().int(),
  tax_amount: z.number().int(),
  total_amount: z.number().int(),
  refunded_amount: z.number().int(),
  currency: z.string(),
  billing_reason: z.string(),
  product_id: z.string().nullish(),
  customer: z.object({ external_id: z.string().nullish() } satisfies Fields<models.OrderCustomer>),
} satisfies Fields<models.Order>)

export class PolarBilling implements BillingProvider {
  readonly provider = 'polar'
  readonly #polar: ReturnType<typeof createPolar>
  readonly #webhookSecret: string
  readonly #products: Readonly<Record<string, string>>
  /** Product → plan. */
  readonly #plans: ReadonlyMap<string, string>
  /** Product → its prices, by id, with whether each is metered; read from Polar once each. */
  readonly #prices = new Map<string, Map<string, boolean>>()
  /** One-time products found by their metadata `purpose` (`balance`, `chip_in`), each read once. */
  readonly #purposes = new Map<string, string | null>()
  /** Each one-time product that sells a year of a plan → that plan, found by metadata once. */
  #years: Map<string, string> | null = null

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
    term?: BillingTerm
    returnUrl: string
  }): Promise<string> {
    const product =
      input.term === 'year' ? await this.#yearProduct(input.planKey) : this.#products[input.planKey]
    if (product === undefined)
      throw new Error(`No Polar product sells the ${input.planKey} plan by the ${input.term}`)
    const checkout = await withEmail(input.email, (email) =>
      call('starting a checkout', () =>
        this.#polar.checkouts.create({
          products: [product],
          // Polar's default too, said here so a code always has a place to be typed.
          allow_discount_codes: true,
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

  /** The one-time product a balance is settled with (metadata `purpose: balance`). */
  #balanceProduct(): Promise<string | null> {
    return this.#purpose('balance')
  }

  /** The one-time product with this metadata `purpose`, read once it is found. */
  async #purpose(purpose: string): Promise<string | null> {
    const known = this.#purposes.get(purpose)
    if (known) return known
    const found = await call(`finding the ${purpose} product`, () =>
      this.#polar.products.list({ metadata: { purpose }, is_archived: false }),
    )
    const id = Products.parse(found).items[0]?.id ?? null
    this.#purposes.set(purpose, id)
    return id
  }

  /**
   * A checkout for the "chip-in" product (metadata `purpose: chip_in`, one-time, any price) at
   * exactly what the payer chose, as an ad-hoc price with tax included, so $5 is $5 wherever they
   * are, naming the server in its metadata. The order carries the metadata, and a refund of part of
   * it is counted before tax (both seen in the sandbox, 2026-10-12).
   */
  async chipInUrl(input: {
    userId: string
    email: string
    serverId: string
    cents: number
    returnUrl: string
  }): Promise<string> {
    const product = await this.#purpose(CHIP_IN)
    if (product === null) throw new Error('No Polar product has the metadata purpose: chip_in')
    const checkout = await withEmail(input.email, (email) =>
      call('starting a chip-in', () =>
        this.#polar.checkouts.create({
          products: [product],
          prices: {
            [product]: [
              {
                amount_type: 'fixed',
                price_amount: input.cents,
                price_currency: 'usd',
                tax_behavior: 'inclusive',
              },
            ],
          },
          metadata: { server: input.serverId },
          // What it buys is what was paid: a code would buy hours for less.
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

  async sellsYear(planKey: string): Promise<boolean> {
    return (await this.#yearProduct(planKey)) !== undefined
  }

  /** The one-time product that sells a year of the plan, if there is one. */
  async #yearProduct(planKey: string): Promise<string | undefined> {
    for (const [product, plan] of await this.#yearProducts()) if (plan === planKey) return product
    return undefined
  }

  /**
   * The products with the metadata `term: year`, each for the paid plan its `plan` names: read
   * once, as the balance product is. One for a plan this deployment doesn't sell grants nothing.
   */
  async #yearProducts(): Promise<ReadonlyMap<string, string>> {
    if (this.#years === null) {
      const found = await call('finding the yearly products', () =>
        this.#polar.products.list({ metadata: { term: 'year' }, is_archived: false }),
      )
      this.#years = new Map(
        Products.parse(found).items.flatMap((product) => {
          const plan = product.metadata.plan
          return typeof plan === 'string' && Object.hasOwn(this.#products, plan)
            ? [[product.id, plan] as const]
            : []
        }),
      )
    }
    return this.#years
  }

  /** As a cancel in the customer portal: the period paid for is kept, and nothing renews it. */
  async stopRenewing(externalSubscriptionId: string): Promise<void> {
    await call('ending a subscription at its period end', () =>
      this.#polar.subscriptions.update(externalSubscriptionId, { cancel_at_period_end: true }),
    )
  }

  /**
   * Revoked, as in Polar's dashboard: it ends now, and Polar neither renews it nor retries a charge
   * for it. Polar refuses one revoked already, which is ended all the same.
   */
  async endSubscription(externalSubscriptionId: string): Promise<void> {
    await call('ending a subscription now', () =>
      this.#polar.subscriptions.revoke(externalSubscriptionId).catch((error: unknown) => {
        if (!(error instanceof errors.AlreadyCanceledSubscription)) throw error
      }),
    )
  }

  async refundedAsWithdrawal(externalOrderId: string): Promise<boolean> {
    const refunds = Refunds.parse(
      await call('reading an order’s refunds', () =>
        this.#polar.refunds.list({ order_id: externalOrderId, limit: 100 }),
      ),
    )
    return refunds.items.some((refund) => refund.reason === WITHDRAWAL_REASON)
  }

  /** Every gift product for a plan this deployment sells, cheapest first, read from Polar now. */
  async giftProducts(): Promise<GiftProduct[]> {
    const found = Listed.parse(
      await call('finding the gift products', () =>
        this.#polar.products.list({ metadata: { ...GIFT_METADATA }, is_archived: false, limit: 100 }),
      ),
    )
    const plans = new Set(this.#plans.values())
    return found.items
      .map((item) => giftOf(item, plans))
      .filter((gift) => gift !== null)
      .sort((a, b) => a.priceCents - b.priceCents)
  }

  /**
   * A checkout for one gift, charged to the buyer as a customer like any other, with no code: a
   * coupon for the plans is not for gifts of them. One still open for the same buyer and gift is
   * the one to pay, as with a balance.
   */
  async giftCheckoutUrl(input: {
    userId: string
    email: string
    gift: GiftProduct
    returnUrl: string
  }): Promise<string> {
    const open = OpenCheckouts.parse(
      await call('finding an open gift checkout', () =>
        this.#polar.checkouts.list({
          product_id: input.gift.id,
          external_customer_id: input.userId,
          status: 'open',
          limit: 20,
        }),
      ),
    ).items.find((checkout) => new Date(checkout.expires_at).getTime() > Date.now() + CHECKOUT_LEFT_MS)
    if (open !== undefined) return open.url
    const checkout = await withEmail(input.email, (email) =>
      call('starting a gift checkout', () =>
        this.#polar.checkouts.create({
          products: [input.gift.id],
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
    const chipIn = await this.#chipIn(order)
    // Only a product no monthly plan names, and not the chip-in one, can sell a year.
    const year =
      order.product_id && !this.#plans.has(order.product_id) && chipIn === null
        ? (await this.#yearProducts()).get(order.product_id)
        : undefined
    // A gift is a product of its own, read only for an order no plan, balance, chip-in or year
    // accounts for.
    const gift =
      order.product_id &&
      !this.#plans.has(order.product_id) &&
      !balance &&
      chipIn === null &&
      year === undefined
        ? await this.#gift(order.product_id)
        : null
    return {
      externalOrderId: order.id,
      userId: order.customer.external_id ?? null,
      planKey: order.product_id ? (this.#plans.get(order.product_id) ?? year ?? null) : null,
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
      chipIn,
      paysForYear: year !== undefined,
      gift,
      orderedAt: new Date(order.created_at),
      changedAt: order.modified_at ? new Date(order.modified_at) : null,
    }
  }

  /**
   * The server an order chipped in to, or null. Only an order for the chip-in product chips in:
   * metadata on anything else is not ours.
   */
  async #chipIn(order: z.infer<typeof Order>): Promise<string | null> {
    const server = String(order.metadata?.server ?? '')
    if (server.length === 0 || !order.product_id || this.#plans.has(order.product_id)) return null
    return order.product_id === (await this.#purpose(CHIP_IN)) ? server : null
  }

  /** The gift a product sells, or null: one that sells none, or that Polar no longer has. */
  async #gift(productId: string): Promise<GiftProduct | null> {
    try {
      const product = await call('reading a product', () => this.#polar.products.get(productId))
      return giftOf(product, new Set(this.#plans.values()))
    } catch (error) {
      if (error instanceof PolarClientError && error.statusCode === 404) return null
      throw error
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

  /** Every page of Polar's discounts, newest first, keeping the codes for the plans' products. */
  async discounts(): Promise<Discount[]> {
    const products = new Set(this.#plans.keys())
    const found: Discount[] = []
    for (let page = 1; ; page++) {
      const listed = DiscountPage.parse(
        await call('listing discount codes', () =>
          this.#polar.discounts.list({ page, limit: 100, sorting: ['-created_at'] }),
        ),
      )
      for (const item of listed.items) {
        const discount = discountOf(item, products)
        if (discount !== null) found.push(discount)
      }
      if (page >= listed.pagination.max_page) return found
    }
  }

  /** A code limited to the plans' products. A code Polar refuses comes back in its own words. */
  async createDiscount(input: NewDiscount): Promise<Discount> {
    const products = Object.values(this.#products)
    try {
      const made = await call('making a discount code', () =>
        this.#polar.discounts.create(discountBody(input, products)),
      )
      const discount = discountOf(made, new Set(products))
      if (discount === null) throw new Error('Polar made a discount that is not a code for these plans')
      return discount
    } catch (error) {
      if (error instanceof PolarClientError && (error.statusCode === 400 || error.statusCode === 422))
        throw new DiscountRefused(refusal(error))
      throw error
    }
  }

  /** Only a code for these plans is deleted; one Polar no longer has is already gone. */
  async deleteDiscount(id: string): Promise<Discount | null> {
    try {
      const held = discountOf(
        await call('reading a discount code', () => this.#polar.discounts.get(id)),
        new Set(this.#plans.keys()),
      )
      if (held !== null) await call('deleting a discount code', () => this.#polar.discounts.delete(id))
      return held
    } catch (error) {
      if (error instanceof PolarClientError && error.statusCode === 404) return null
      throw error
    }
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
              canceledAt: paid.canceled_at ? new Date(paid.canceled_at) : null,
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
  if (!(error instanceof errors.HTTPValidationError)) return false
  return (error.error.detail ?? []).some((problem) => problem.loc?.includes('customer_email'))
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
