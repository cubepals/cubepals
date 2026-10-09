/**
 * Local development's stand-in for Polar (docs/local-development.md), which configuration allows
 * nowhere else. Checkout and the customer portal are this adapter's own pages (checkout-pages.ts),
 * and what they do arrives as a signed delivery at the webhook Polar's would, so a plan is granted
 * and cancelled the way a payment grants and cancels it. Nothing is charged.
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
  page: 'checkout' | 'portal'
  userId: string
  /** The plan a checkout is for; null for the portal. */
  planKey: string | null
  returnUrl: string
  expires: number
}

/** What a page did, as the webhook receives it. */
export type Delivery =
  | { type: 'subscription.started'; userId: string; planKey: string }
  | { type: 'subscription.cancelled'; userId: string }

export class LocalBilling implements BillingProvider {
  readonly provider = 'local'
  readonly #db: Db
  readonly #key: Buffer
  readonly #webOrigin: string

  constructor(options: { db: Db; secret: string; webOrigin: string }) {
    this.#db = options.db
    // A key of its own, so nothing signed here passes for anything signed with the secret itself.
    this.#key = createHmac('sha256', options.secret).update('local-billing').digest()
    this.#webOrigin = options.webOrigin
  }

  async checkoutUrl(input: { userId: string; planKey: string; returnUrl: string }): Promise<string> {
    return this.#link({
      page: 'checkout',
      userId: input.userId,
      planKey: input.planKey,
      returnUrl: input.returnUrl,
    })
  }

  async portalUrl(input: { userId: string; returnUrl: string }): Promise<string> {
    return this.#link({ page: 'portal', userId: input.userId, planKey: null, returnUrl: input.returnUrl })
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
