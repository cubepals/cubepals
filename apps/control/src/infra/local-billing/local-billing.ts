// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Local development's stand-in for Polar (docs/local-development.md), which configuration allows
 * nowhere else. Checkout and the customer portal are this adapter's own pages (checkout-pages.ts),
 * and what they do arrives as a signed delivery at the webhook Polar's would, so a plan is granted
 * and cancelled the way a payment grants and cancels it, with the paid order a checkout makes.
 * Nothing is charged, and extra play is kept here (`reported`) rather than sent anywhere. Discount
 * codes are kept in memory until a restart, to try the admin pages with; its checkout takes none.
 * It sells the gifts it is given (a month of each paid plan), through a page of its own, to an
 * account or a guest, and files a guest's order as Polar does: under the account with their email,
 * if there is one.
 *
 * Its record of who pays is `billing_subscriptions` itself: a provider keeps its own, and this one
 * has nowhere else to keep it.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { BillingTerm } from '@blockly/contracts'
import { DAY_MS, HOUR_MS } from '@blockly/contracts/durations'
import { type Db, schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import {
  type BillingEvent,
  type BillingProvider,
  type BillingState,
  type Discount,
  DiscountRefused,
  type EarlyProduct,
  type GiftProduct,
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
const TICKET_MS = HOUR_MS
/** How long a plan started here runs before it would renew: a year, so a test account keeps it. */
const PERIOD_MS = 365 * DAY_MS

/** What a link to a page carries: whose it is, what it is for, and where it goes back to. */
export interface Ticket {
  page: 'checkout' | 'portal' | 'settle' | 'gift' | 'chip_in'
  /** Whose it is; null only for a gift a guest buys. */
  userId: string | null
  /** The plan a checkout is for, and what Blockly says it costs; null and 0 for the portal. */
  planKey: string | null
  priceCents: number
  /** A checkout for a year of the plan, paid once, rather than a subscription. */
  year?: boolean
  /** The early product a month is sold on, in place of the plan's own. */
  productId?: string
  /** The gift a gift page sells, the gift made before its checkout, and the email it is paid with. */
  gift?: GiftProduct
  giftId?: string
  email?: string
  /** The orders a payment settles, for the settle page. */
  settles?: string[]
  /** The server a chip-in is for. */
  serverId?: string
  returnUrl: string
  expires: number
}

/** What a page did, as the webhook receives it. */
export type Delivery =
  | { type: 'subscription.started'; userId: string; planKey: string; productId?: string }
  | { type: 'subscription.cancelled'; userId: string }
  | {
      type: 'order.paid'
      userId: string | null
      planKey: string | null
      cents: number
      settles?: string[]
      year?: boolean
      gift?: GiftProduct
      giftId?: string
      payerEmail?: string
      chipIn?: string
    }

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
  readonly #gifts: readonly GiftProduct[]
  readonly #early: readonly EarlyProduct[]

  constructor(options: {
    db: Db
    secret: string
    webOrigin: string
    gifts?: readonly GiftProduct[]
    /** Products at an early price it sells, as a provider would hold them; none unless given. */
    early?: readonly EarlyProduct[]
  }) {
    this.#db = options.db
    this.#gifts = options.gifts ?? []
    this.#early = options.early ?? []
    // A key of its own, so nothing signed here passes for anything signed with the secret itself.
    this.#key = createHmac('sha256', options.secret).update('local-billing').digest()
    this.#webOrigin = options.webOrigin
  }

  async checkoutUrl(input: {
    userId: string
    planKey: string
    term?: BillingTerm
    priceCents?: number
    productId?: string
    returnUrl: string
  }): Promise<string> {
    return this.#link({
      page: 'checkout',
      userId: input.userId,
      planKey: input.planKey,
      priceCents: input.priceCents ?? 0,
      ...(input.term === 'year' ? { year: true } : {}),
      ...(input.term !== 'year' && input.productId !== undefined ? { productId: input.productId } : {}),
      returnUrl: input.returnUrl,
    })
  }

  /** Every plan is sold here. */
  sells(): boolean {
    return true
  }

  /** Every plan is sold by the year here, as by the month. */
  async sellsYear(): Promise<boolean> {
    return true
  }

  /** The newest of those it was given for the plan, not archived; as Polar's offers one. */
  async earlyProduct(planKey: string): Promise<EarlyProduct | null> {
    const offered = this.#early.filter((product) => product.planKey === planKey && !product.archived)
    return offered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
  }

  /** The move is the record `BillingService` writes; here nothing else applies it, and a plan runs its year. */
  async moveToPlan(externalSubscriptionId: string): Promise<{ appliesAt: Date }> {
    const [row] = await this.#db
      .select({ end: schema.billingSubscriptions.currentPeriodEnd })
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.externalSubscriptionId, externalSubscriptionId))
    return { appliesAt: row?.end ?? new Date() }
  }

  /**
   * Its record of who pays is `billing_subscriptions` itself: the plan is the larger one from now,
   * renewing, on the early product named, with what it sells, or on the plan's own.
   */
  async upgradeSubscription(
    externalSubscriptionId: string,
    planKey: string,
    productId?: string,
  ): Promise<void> {
    const { terms } = this.#product(productId)
    await this.#db
      .update(schema.billingSubscriptions)
      .set({
        planKey,
        productId: productId ?? null,
        priceCents: terms?.priceCents ?? null,
        includedUnits: terms?.includedUnits ?? null,
        mostExtraUnits: terms?.mostExtraUnits ?? null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.billingSubscriptions.externalSubscriptionId, externalSubscriptionId))
  }

  /** Its record of who pays is `billing_subscriptions` itself, so the cancel is written there. */
  async stopRenewing(externalSubscriptionId: string): Promise<void> {
    await this.#db
      .update(schema.billingSubscriptions)
      .set({ cancelAtPeriodEnd: true, canceledAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.billingSubscriptions.provider, this.provider),
          eq(schema.billingSubscriptions.externalSubscriptionId, externalSubscriptionId),
        ),
      )
  }

  /** Its record of who pays is `billing_subscriptions`, where Blockly marks it ended itself. */
  async endSubscription(): Promise<void> {}

  /** Nothing was charged here, so nothing is refunded as a withdrawal. */
  async refundedAsWithdrawal(): Promise<boolean> {
    return false
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

  async giftProducts(): Promise<GiftProduct[]> {
    return [...this.#gifts]
  }

  /** The gift page: a payment for a gift, with nothing charged, as the others. */
  async giftCheckoutUrl(input: {
    userId: string | null
    email: string
    gift: GiftProduct
    giftId: string | null
    returnUrl: string
  }): Promise<string> {
    if (input.userId === null && input.giftId === null)
      throw new Error('A guest’s gift is made before its checkout, which names it')
    return this.#link({
      page: 'gift',
      userId: input.userId,
      planKey: null,
      priceCents: input.gift.priceCents,
      gift: input.gift,
      ...(input.giftId === null ? {} : { giftId: input.giftId }),
      email: input.email,
      returnUrl: input.returnUrl,
    })
  }

  /** The chip-in page: hours for a friend's server, with nothing charged, as the others. */
  async chipInUrl(input: {
    userId: string
    serverId: string
    cents: number
    returnUrl: string
  }): Promise<string> {
    return this.#link({
      page: 'chip_in',
      userId: input.userId,
      planKey: null,
      priceCents: input.cents,
      serverId: input.serverId,
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
          userId: await this.#payer(event),
          planKey: event.planKey,
          billingReason: event.planKey === null || event.year ? 'purchase' : 'subscription_create',
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
          // Only the chip-in page sends a server.
          chipIn: event.planKey === null ? (event.chipIn ?? null) : null,
          paysForYear: event.year === true && event.planKey !== null,
          gift: event.gift ?? null,
          giftId: event.giftId,
          payerEmail: event.payerEmail,
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
              ...this.#product(event.productId),
            }
          : null,
    }
    return { kind: 'standing', state }
  }

  /**
   * The product a subscription is on and what it sells the plan with: one of its early products, or
   * any other, which sells the plan's own. Nothing for a delivery that names none.
   */
  #product(
    productId: string | undefined,
  ): Pick<NonNullable<BillingState['subscription']>, 'productId' | 'terms'> {
    if (productId === undefined) return {}
    const early = this.#early.find((product) => product.id === productId)
    return {
      productId,
      terms:
        early === undefined
          ? null
          : {
              priceCents: early.priceCents,
              includedUnits: early.includedUnits,
              mostExtraUnits: early.mostExtraUnits,
            },
    }
  }

  /**
   * Whose order it is: the account that paid, or for a guest the account with their email, as
   * Polar finds its customer by the email a guest pays with; null with none.
   */
  async #payer(event: { userId: string | null; payerEmail?: string }): Promise<string | null> {
    if (event.userId !== null || event.payerEmail === undefined) return event.userId
    const [user] = await this.#db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, event.payerEmail))
    return user?.id ?? null
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
              ...this.#product(paying.productId ?? undefined),
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
