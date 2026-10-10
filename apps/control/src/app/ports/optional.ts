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
  } | null
}

/** A paid order, as the billing provider reports it: what it was for, and every amount in cents. */
export interface BillingOrder {
  externalOrderId: string
  /** Our user id, from the customer's external id; null for a customer this deployment didn't make. */
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
  orderedAt: Date
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
   * charge it (the local checkout); Polar's product sets its own price.
   */
  checkoutUrl(input: {
    userId: string
    email: string
    planKey: string
    priceCents?: number
    returnUrl: string
  }): Promise<string>
  portalUrl(input: { userId: string; returnUrl: string }): Promise<string>
  /**
   * A one-time payment for orders the provider can no longer collect (their subscription ended),
   * which its order then names in `settles`. No discount code applies to it.
   */
  settleUrl(input: {
    userId: string
    email: string
    cents: number
    settles: readonly string[]
    returnUrl: string
  }): Promise<string>
  /**
   * One webhook delivery, from the raw body: the standing or the order it reports, or null for a
   * delivery that reports neither. A delivery that isn't authentic is a WebhookRejected.
   */
  receive(body: string, headers: Readonly<Record<string, string>>): Promise<BillingEvent | null>
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
}

/** A webhook that didn't come from the provider, or was altered, or replayed. */
export class WebhookRejected extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'WebhookRejected'
  }
}

/** The provider couldn't answer: its outage, its rate limit, or the network between. */
export class BillingUnavailable extends Error {
  constructor(detail: string) {
    super(`Billing is unavailable: ${detail}`)
    this.name = 'BillingUnavailable'
  }
}
