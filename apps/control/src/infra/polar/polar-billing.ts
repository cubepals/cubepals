import { PolarClientError, PolarError, PolarRateLimitError } from '@polar-sh/sdk'
import { createPolar, webhooks } from '@polar-sh/sdk/2026-04'
import { z } from 'zod'
import {
  type BillingEvent,
  type BillingOrder,
  type BillingProvider,
  type BillingState,
  BillingUnavailable,
  WebhookRejected,
} from '../../app/ports/optional.ts'

/**
 * Polar through its official TypeScript SDK, pinned to API version 2026-04 for requests and for
 * webhook payloads (docs/dependency-audit.md). Customers carry our user id as their external id,
 * so nothing maps Polar's own ids back to users. A plan is a product; configuration says which.
 */

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
    }),
  ),
})

// A customer state lists only subscriptions that pay now, `active` or `trialing` (Polar's
// `SubscriptionStatus.active_statuses`, read 2026-09-26); one whose renewal failed is `past_due`
// on the subscription itself while Polar retries the charge.
const Subscription = z.object({
  status: z.string(),
  current_period_end: z.string().nullish(),
  past_due_at: z.string().nullish(),
})

// The fields of Polar's `Order` (SDK 2026-04 `models`, read 2026-09-26) that revenue needs: every
// amount is in cents, and the customer carries the external id Blockly gave it.
const Order = z.object({
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
    const create = (email: string | null) =>
      call('starting a checkout', () =>
        this.#polar.checkouts.create({
          products: [product],
          external_customer_id: input.userId,
          ...(email === null ? {} : { customer_email: email }),
          success_url: input.returnUrl,
          return_url: input.returnUrl,
        }),
      )
    // An address Polar won't take (one on a reserved domain, as local test accounts have) isn't the
    // person's to fix: the checkout opens without it and asks them for one.
    const checkout = await create(input.email).catch((error: unknown) => {
      if (refusesEmail(error)) return create(null)
      throw error
    })
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
    if (event.type === 'order.paid' || event.type === 'order.refunded')
      return { kind: 'order', order: this.#order(event.data) }
    if (event.type !== 'customer.state_changed') return null
    const sent = this.#standing(event.data)
    if (sent === null) return null
    // A customer Polar no longer has pays for nothing.
    return { kind: 'standing', state: (await this.stateOf(sent.userId)) ?? { ...sent, subscription: null } }
  }

  #order(data: unknown): BillingOrder {
    const order = Order.parse(data)
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
      orderedAt: new Date(order.created_at),
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
            },
    }
  }
}

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
