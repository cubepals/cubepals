// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { BillingTerm } from '@blockly/contracts'
import type { ArchiveTarget, DownloadTarget, UploadTarget } from './runtime.ts'

/**
 * Who will use a presigned link: a game runtime, from inside the provider's network, or a person's
 * browser. One address serves both in production; locally, containers and the host reach the store
 * by different names, and a link is signed for the name its user will call.
 */
export type LinkAudience = 'runtime' | 'browser'

/**
 * Object storage, when a deployment has it. Generic primitives only: it knows nothing about
 * servers, revisions or policy. Absent from a deployment means the archives capability is off.
 */
export interface ArchiveStore {
  /**
   * The key for a new object, laid out as this store keeps them (§4: an archive's key is issued
   * by the store). Artifacts are keyed by their bytes in `ingestFromUrl` instead.
   */
  newKey(
    kind: 'archive' | 'world_upload' | 'world_download' | 'mod_upload' | 'pack_upload',
    scope: { serverId: string; id: string },
  ): string
  /**
   * A link that stores one object. With `sizeBytes`, the length is part of the signature and the
   * store refuses a body of any other size, so a browser can't put more than it said it would.
   */
  presignPut(
    key: string,
    ttlSeconds: number,
    audience: LinkAudience,
    sizeBytes?: number,
  ): Promise<UploadTarget>
  presignGet(
    key: string,
    ttlSeconds: number,
    audience: LinkAudience,
    downloadName?: string,
  ): Promise<DownloadTarget>
  /**
   * Where a runtime writes an archive under `key`: a presigned PUT for one that fits, and, for one
   * larger than a PUT carries, an upload in parts begun when the runtime asks for it. Nothing is
   * stored until the upload completes; one never completed is dropped with `abort`.
   */
  archiveTarget(key: string, ttlSeconds: number, audience: LinkAudience): Promise<ArchiveTarget>
  /**
   * Copies a public URL into the store under a content-addressed key and returns the key. The
   * bytes are checked before they are stored; different bytes are an ArtifactMismatch.
   */
  ingestFromUrl(url: string, sha512: string): Promise<string>
  /**
   * Stores a file on this machine under a content-addressed key and returns the key, as
   * `ingestFromUrl` does for a URL: a pack Blockly built. Different bytes are an ArtifactMismatch.
   */
  ingestFile(path: string, sha512: string): Promise<string>
  head(key: string): Promise<{ sizeBytes: number } | null>
  delete(key: string): Promise<void>
}

/** A URL served other bytes than the ones asked for, or more of them than the store takes. */
export class ArtifactMismatch extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'ArtifactMismatch'
  }
}

/** A customer's paid standing, as the billing provider knows it. */
export interface BillingState {
  /** Our user id: the provider keeps it as the customer's external id. */
  userId: string
  externalCustomerId: string
  /** The paid plan in force; null when nothing paid is active. */
  subscription: {
    externalSubscriptionId: string
    planKey: string
    status: 'active' | 'trialing'
    currentPeriodEnd: Date
    cancelAtPeriodEnd: boolean
    /** When the provider made it, where it says; which of an account's subscriptions is newest. */
    createdAt?: Date
    /** When it was set to end, where the provider says; null while it renews. */
    canceledAt?: Date | null
  } | null
}

/**
 * A product that sells a paid plan at a price and with hours of its own: an early price. More than
 * one may sell the same plan, a later one standing for new checkouts while the ones before it go
 * on speaking for the subscriptions sold on them, archived or not.
 */
export interface EarlyProduct {
  id: string
  planKey: string
  /** What it charges a month, in US cents. */
  priceCents: number
  /** The play it includes each month, in meter units, in place of the plan's. */
  includedUnits: number
  /** The most extra hours a month it lets an owner allow, in place of the plan's; null: the ceiling alone. */
  mostExtraUnits: number | null
  /** Sold no more. */
  archived: boolean
  createdAt: Date
}

/** A paid order, as the billing provider reports it: what it was for, and every amount in cents. */
export interface BillingOrder {
  externalOrderId: string
  /**
   * Our user id, from the customer's external id; null for a customer this deployment didn't make.
   * For a gift a guest bought it is whichever account the provider matched their email to, if any,
   * which `Gifts.payer` sets aside.
   */
  userId: string | null
  /** The plan its product sells; null for a product no plan names. */
  planKey: string | null
  billingReason: string
  currency: string
  subtotalCents: number
  discountCents: number
  netCents: number
  taxCents: number
  totalCents: number
  refundedCents: number
  /** `paid`; `pending` while its charge hasn't gone through; `refunded`, `void`… as the provider says. */
  status: string
  /** What of it is extra play (the metered line), before discounts and tax. */
  extraCents: number
  /** The subscription it charged for; null for none. */
  externalSubscriptionId: string | null
  /** Orders it paid for in their place: a balance settled (`settleUrl`). */
  settles: string[]
  /** It is for the provider's balance product, the only one whose `settles` is believed. */
  balance: boolean
  /**
   * The server it chipped in to (`chipInUrl`): only an order of the provider's chip-in product
   * names one; null for any other.
   */
  chipIn: string | null
  /** It paid for a year of `planKey` at once, with no subscription to renew it (`plan_years`). */
  paysForYear: boolean
  /** What it bought as a gift, when it is for one of the provider's gift products. */
  gift?: GiftProduct | null
  /** The gift it paid for, when the gift was made before its checkout, which named it. */
  giftId?: string | null
  /** The email it was paid with, as the provider has it: read for a gift, for its buyer. */
  payerEmail?: string | null
  orderedAt: Date
  /** When the provider last changed it (paid, refunded…), where it says. */
  changedAt?: Date | null
}

/**
 * A gift the provider sells as a one-time product: `months` of `planKey` for someone else, at
 * `priceCents` before any tax. `id` is the product's.
 */
export interface GiftProduct {
  id: string
  planKey: string
  months: number
  priceCents: number
}

/** An order as the provider holds it now, and whether a charge for it was tried and failed. */
export interface OrderNow {
  order: BillingOrder
  chargeFailed: boolean
}

/**
 * Extra play to bill, one event of it: `hours` as the meter counts them (a large server two an
 * hour), counted up to `at`, which is never ahead of the clock. `externalId` is the provider's
 * permanent key for the event: sent twice, it is billed once.
 */
export interface UsageEvent {
  externalId: string
  userId: string
  hours: number
  at: Date
}

/**
 * A discount code for the plans a deployment sells, as a customer types it at checkout: a share
 * of the price or a fixed amount off (US cents), for the first payment, every one, or `months`
 * of them. `maxRedemptions` and `endsAt` are null for no limit.
 */
export interface NewDiscount {
  code: string
  off: { kind: 'percent'; percent: number } | { kind: 'amount'; cents: number }
  duration: { kind: 'once' } | { kind: 'forever' } | { kind: 'months'; months: number }
  maxRedemptions: number | null
  endsAt: Date | null
}

/** A discount code as the provider holds it, with how many times it was used. */
export interface Discount extends NewDiscount {
  id: string
  redemptions: number
  createdAt: Date
}

/** The provider wouldn't make a discount (a code already taken, say), in its own words. */
export class DiscountRefused extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'DiscountRefused'
  }
}

/** What one webhook delivery reports: a customer's standing, or an order paid or refunded. */
export type BillingEvent = { kind: 'standing'; state: BillingState } | { kind: 'order'; order: BillingOrder }

/**
 * Checkout and portal links, authenticated webhooks, and a customer's current standing. Absent
 * means entitlements come from the plan column alone.
 */
export interface BillingProvider {
  /** The provider's name, as `billing_subscriptions` records it. */
  readonly provider: string
  /**
   * `priceCents`: what Blockly says the plan costs, for a provider with no product of its own to
   * charge it (the local checkout); Polar's product sets its own price. `term: 'year'` is the
   * plan's yearly product, paid once and never renewed: its order says `paysForYear`. The month
   * when it says nothing.
   */
  checkoutUrl(input: {
    userId: string
    email: string
    planKey: string
    term?: BillingTerm
    priceCents?: number
    returnUrl: string
  }): Promise<string>
  /**
   * Whether a product sells the plan here. A paid plan with none is not for sale yet: its card and
   * checkout say so, and nothing fails.
   */
  sells(planKey: string): boolean
  /** The plan's yearly product is sold here: a checkout for it can be made. */
  sellsYear(planKey: string): Promise<boolean>
  /**
   * The product that sells the plan at an early price now, the newest not archived; null when none
   * does. Nothing offers it on its own: what may be sold at it is Blockly's to decide.
   */
  earlyProduct(planKey: string): Promise<EarlyProduct | null>
  /**
   * The subscription ends at the end of the period paid for instead of renewing, as a cancel in
   * the portal would: a year was bought to follow it.
   */
  stopRenewing(externalSubscriptionId: string): Promise<void>
  /**
   * The subscription changes to another plan's product when the period paid for ends, and keeps
   * its own until then (Plus to Core). Answers when it applies.
   */
  moveToPlan(externalSubscriptionId: string, planKey: string): Promise<{ appliesAt: Date }>
  /**
   * The subscription becomes another plan's product now, the one subscription kept (Core to Plus):
   * the larger plan's price replaces the smaller, the difference for the rest of the period is
   * charged at once, and no second subscription renews beside it. One set to end with its period
   * is made to renew first: the provider changes the product of none else.
   */
  upgradeSubscription(externalSubscriptionId: string, planKey: string): Promise<void>
  /**
   * The subscription ends now, and nothing more is charged for it: its first month was withdrawn,
   * or its renewal is still unpaid when the plan's grace runs out. One ended already stays ended.
   */
  endSubscription(externalSubscriptionId: string): Promise<void>
  /** A refund of the order was the withdrawal the Refunds page offers, by the provider's reason for it. */
  refundedAsWithdrawal(externalOrderId: string): Promise<boolean>
  portalUrl(input: { userId: string; returnUrl: string }): Promise<string>
  /**
   * A one-time payment for orders the provider can no longer collect (their subscription ended),
   * which its order then names in `settles`. `cents` is what they came to before tax, and tax is
   * added on top. No discount code applies to it. A checkout still open for the same orders and
   * amount is offered again rather than a second one.
   */
  settleUrl(input: {
    userId: string
    email: string
    cents: number
    settles: readonly string[]
    returnUrl: string
  }): Promise<string>
  /**
   * A one-time payment of `cents`, tax included, that chips in hours of play to a friend's server,
   * which its order then names in `chipIn`. No discount code applies to it.
   */
  chipInUrl(input: {
    userId: string
    email: string
    serverId: string
    cents: number
    returnUrl: string
  }): Promise<string>
  /**
   * One webhook delivery, from the raw body: the standing or the order it reports, or null for a
   * delivery that reports neither. A delivery that isn't authentic is a WebhookRejected.
   */
  receive(body: string, headers: Readonly<Record<string, string>>): Promise<BillingEvent | null>
  /**
   * The order as the provider holds it now, and whether its charge failed; null for an order it
   * doesn't know. Read before an account is held to owe it, so a lost webhook never blocks
   * someone who paid.
   */
  order(externalOrderId: string): Promise<OrderNow | null>
  /** The gifts on sale, cheapest first; none when the provider sells none. */
  giftProducts(): Promise<GiftProduct[]>
  /**
   * A checkout for one gift, with no discount code, paid by `userId` or, where that is null, by a
   * guest at `email`. `giftId` is the gift made before its checkout, which its order names; null
   * for one its paid order makes, which a guest's never is. A checkout still open for the same
   * buyer and gift is offered again rather than a second one.
   */
  giftCheckoutUrl(input: {
    userId: string | null
    email: string
    gift: GiftProduct
    giftId: string | null
    returnUrl: string
  }): Promise<string>
  /** Gives back `cents` of a paid order, before tax (the provider refunds its tax with it). */
  refund(input: { externalOrderId: string; cents: number; why: string }): Promise<void>
  /** The customer's standing now; null for someone who was never a customer. */
  stateOf(userId: string): Promise<BillingState | null>
  /**
   * Why a subscription left the standing: when its renewal failed to charge, while the provider
   * still retries it; null when it ended (cancelled, revoked, retries spent, or never known). A
   * standing lists only subscriptions that pay now, so it can't tell the two apart on its own.
   */
  pastDueSince(externalSubscriptionId: string): Promise<Date | null>
  /**
   * Extra play for the provider to add to each account's next payment. All or nothing: it throws
   * when the provider didn't take them, and they are sent again, under the same ids, later.
   */
  reportUsage(events: readonly UsageEvent[]): Promise<void>
  /** Discount codes that apply to the plans this deployment sells, newest first. */
  discounts(): Promise<Discount[]>
  /** A code customers can type at checkout for those plans. One refused is a DiscountRefused. */
  createDiscount(input: NewDiscount): Promise<Discount>
  /** Deletes one of `discounts()` and answers what it was; null when there is no such code. */
  deleteDiscount(id: string): Promise<Discount | null>
}

/** A webhook that didn't come from the provider, or was altered, or replayed. */
export class WebhookRejected extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'WebhookRejected'
  }
}

/**
 * The provider couldn't answer: its outage, its rate limit, the network between, or its refusal of
 * Blockly's own credentials.
 */
export class BillingUnavailable extends Error {
  constructor(detail: string) {
    super(`Billing is unavailable: ${detail}`)
    this.name = 'BillingUnavailable'
  }
}
