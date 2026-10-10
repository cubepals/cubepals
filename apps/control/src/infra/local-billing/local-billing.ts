/**
 * Local development's stand-in for Polar (docs/local-development.md), which configuration allows
 * nowhere else. Checkout and the customer portal are this adapter's own pages (checkout-pages.ts),
 * and what they do arrives as a signed delivery at the webhook Polar's would, so a plan is granted
 * and cancelled the way a payment grants and cancels it, with the paid order a checkout makes.
 * Nothing is charged, and extra play is kept here (`reported`) rather than sent anywhere. Discount
 * codes are kept in memory until a restart, to try the admin pages with; its checkout takes none.
 *
 * Its record of who pays is `billing_subscriptions` itself: a provider keeps its own, and this one
 * has nowhere else to keep it.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { type Db, schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import {
  type BillingEvent,
  type BillingProvider,
  type BillingState,
  type Discount,
  DiscountRefused,
  type NewDiscount,
  type OrderNow,
  type UsageEvent,
  WebhookRejected,
} from '../../app/ports/optional.ts'

/** Where the pages are, under the web origin's /api rewrite. */
export const LOCAL_BILLING_PATH = '/api/billing/local'

/** The header a delivery's signature travels in. */
const SIGNATURE = 'x-local-billing-signature'
/** How long a link to a page works. */
const TICKET_MS = 60 * 60_000
/** How long a plan started here runs before it would renew: a year, so a test account keeps it. */
const PERIOD_MS = 365 * 24 * 60 * 60_000

/** What a link to a page carries: whose it is, what it is for, and where it goes back to. */
export interface Ticket {
  page: 'checkout' | 'portal' | 'settle'
  userId: string
  /** The plan a checkout is for, and what Blockly says it costs; null and 0 for the portal. */
  planKey: string | null
  priceCents: number
  /** The orders a payment settles, for the settle page. */
  settles?: string[]
  returnUrl: string
  expires: number
}

/** What a page did, as the webhook receives it. */
export type Delivery =
  | { type: 'subscription.started'; userId: string; planKey: string }
  | { type: 'subscription.cancelled'; userId: string }
  | { type: 'order.paid'; userId: string; planKey: string | null; cents: number; settles?: string[] }

export class LocalBilling implements BillingProvider {
  readonly provider = 'local'
  readonly #db: Db
  readonly #key: Buffer
  readonly #webOrigin: string
  /** The extra play reported, as a provider would have billed it: for the developer, and tests. */
  readonly reported: UsageEvent[] = []
  /** The refunds asked for. */
  readonly refunded: Array<{ externalOrderId: string; cents: number; why: string }> = []
  /** Discount codes made here, newest first. */
  readonly #discounts: Discount[] = []

  constructor(options: { db: Db; secret: string; webOrigin: string }) {
    this.#db = options.db
    // A key of its own, so nothing signed here passes for anything signed with the secret itself.
    this.#key = createHmac('sha256', options.secret).update('local-billing').digest()
    this.#webOrigin = options.webOrigin
  }

  async checkoutUrl(input: {
    userId: string
    planKey: string
    priceCents?: number
    returnUrl: string
  }): Promise<string> {
    return this.#link({
      page: 'checkout',
      userId: input.userId,
      planKey: input.planKey,
      priceCents: input.priceCents ?? 0,
      returnUrl: input.returnUrl,
    })
  }

  async portalUrl(input: { userId: string; returnUrl: string }): Promise<string> {
    return this.#link({
      page: 'portal',
      userId: input.userId,
      planKey: null,
      priceCents: 0,
      returnUrl: input.returnUrl,
    })
  }

  /** The settle page: a payment for what is owed, with nothing charged, as the others. */
  async settleUrl(input: {
    userId: string
    cents: number
    settles: readonly string[]
    returnUrl: string
  }): Promise<string> {
    return this.#link({
      page: 'settle',
      userId: input.userId,
      planKey: null,
      priceCents: input.cents,
      settles: [...input.settles],
      returnUrl: input.returnUrl,
    })
  }

  /** The ticket a page's link carries, when it was signed here and still works; null otherwise. */
  ticket(value: string, page: Ticket['page'], now = Date.now()): Ticket | null {
    const [payload = '', signature = ''] = value.split('.')
    if (!this.#verify(`ticket.${payload}`, signature)) return null
    const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Ticket
    return ticket.page === page && ticket.expires > now ? ticket : null
  }

  /** A delivery for the webhook, signed as only this deployment can. */
  delivery(event: Delivery): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify(event)
    return {
      body,
      headers: { 'content-type': 'application/json', [SIGNATURE]: this.#sign(`delivery.${body}`) },
    }
  }

  async receive(body: string, headers: Readonly<Record<string, string>>): Promise<BillingEvent | null> {
    if (!this.#verify(`delivery.${body}`, headers[SIGNATURE] ?? ''))
      throw new WebhookRejected('the local checkout did not sign this delivery')
    const event = JSON.parse(body) as Delivery
    if (event.type === 'order.paid') {
      const cents = event.cents
      return {
        kind: 'order',
        order: {
          externalOrderId: `local-${randomUUID()}`,
          userId: event.userId,
          planKey: event.planKey,
          billingReason: event.planKey === null ? 'purchase' : 'subscription_create',
          currency: 'usd',
          subtotalCents: cents,
          discountCents: 0,
          netCents: cents,
          taxCents: 0,
          totalCents: cents,
          refundedCents: 0,
          status: 'paid',
          extraCents: 0,
          externalSubscriptionId: null,
          settles: event.settles ?? [],
          // Only the settle page sends what it settles.
          balance: event.planKey === null && (event.settles ?? []).length > 0,
          orderedAt: new Date(),
        },
      }
    }
    const state: BillingState = {
      userId: event.userId,
      externalCustomerId: `local-${event.userId}`,
      subscription:
        event.type === 'subscription.started'
          ? {
              externalSubscriptionId: `local-${randomUUID()}`,
              planKey: event.planKey,
              status: 'active',
              currentPeriodEnd: new Date(Date.now() + PERIOD_MS),
              cancelAtPeriodEnd: false,
            }
          : null,
    }
    return { kind: 'standing', state }
  }

  async stateOf(userId: string): Promise<BillingState | null> {
    const rows = await this.#db
      .select()
      .from(schema.billingSubscriptions)
      .where(
        and(
          eq(schema.billingSubscriptions.userId, userId),
          eq(schema.billingSubscriptions.provider, this.provider),
        ),
      )
      .orderBy(desc(schema.billingSubscriptions.updatedAt))
    if (rows.length === 0) return null
    const paying = rows.find((row) => row.status === 'active')
    return {
      userId,
      externalCustomerId: `local-${userId}`,
      subscription:
        paying === undefined
          ? null
          : {
              externalSubscriptionId: paying.externalSubscriptionId,
              planKey: paying.planKey,
              status: 'active',
              currentPeriodEnd: paying.currentPeriodEnd ?? new Date(Date.now() + PERIOD_MS),
              cancelAtPeriodEnd: paying.cancelAtPeriodEnd,
            },
    }
  }

  /** Nothing here fails to charge. */
  async pastDueSince(): Promise<Date | null> {
    return null
  }

  /** Nothing was charged, so a refund only is kept, for the developer and tests. */
  async refund(input: { externalOrderId: string; cents: number; why: string }): Promise<void> {
    this.refunded.push(input)
  }

  /** Every order made here is paid when it is made, so none is ever owed. */
  async order(): Promise<OrderNow | null> {
    return null
  }

  /** Kept, once each, the way a provider keeps an event's id. */
  async reportUsage(events: readonly UsageEvent[]): Promise<void> {
    for (const event of events)
      if (!this.reported.some((kept) => kept.externalId === event.externalId)) this.reported.push(event)
  }

  async discounts(): Promise<Discount[]> {
    return [...this.#discounts]
  }

  /** A code is one of a kind, whatever its case, as a provider holds it. */
  async createDiscount(input: NewDiscount): Promise<Discount> {
    const code = input.code.toLowerCase()
    if (this.#discounts.some((held) => held.code.toLowerCase() === code))
      throw new DiscountRefused('A discount with this code already exists.')
    const discount: Discount = {
      ...input,
      id: `local-${randomUUID()}`,
      redemptions: 0,
      createdAt: new Date(),
    }
    this.#discounts.unshift(discount)
    return discount
  }

  async deleteDiscount(id: string): Promise<Discount | null> {
    const at = this.#discounts.findIndex((held) => held.id === id)
    return at === -1 ? null : (this.#discounts.splice(at, 1)[0] ?? null)
  }

  #link(ticket: Omit<Ticket, 'expires'>): string {
    const payload = Buffer.from(JSON.stringify({ ...ticket, expires: Date.now() + TICKET_MS })).toString(
      'base64url',
    )
    const url = new URL(`${LOCAL_BILLING_PATH}/${ticket.page}`, this.#webOrigin)
    url.searchParams.set('ticket', `${payload}.${this.#sign(`ticket.${payload}`)}`)
    return url.toString()
  }

  #sign(value: string): string {
    return createHmac('sha256', this.#key).update(value).digest('base64url')
  }

  #verify(value: string, signature: string): boolean {
    const want = Buffer.from(this.#sign(value))
    const got = Buffer.from(signature)
    return got.length === want.length && timingSafeEqual(got, want)
  }
}
