// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type BillingTerm,
  type CheckoutConsent,
  type PublicOffer,
  sameSitePath,
  type UpgradeReason,
} from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsFor, PAID_PLANS, planName } from '../../domain/account/entitlements.ts'
import { dollars } from '../../domain/policy/spend.ts'
import { emailOf, isTestAccount, loadStanding, lockStanding } from '../accounts/persistence.ts'
import type { AccountService } from '../accounts/service.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { yearEnding } from '../emails/billing.ts'
import { AppError, NotFound } from '../errors.ts'
import { FUNNEL, noteOnce } from '../insight/record.ts'
import { listingsOfOwner } from '../listings/persistence.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { Limits } from '../ports/limits.ts'
import {
  type BillingOrder,
  type BillingStanding,
  type BillingState,
  BillingUnavailable,
} from '../ports/optional.ts'
import type { Mailer } from '../ports/platform.ts'
import { tuning } from '../tuning.ts'
import {
  accountsWithLapses,
  type BillingSource,
  planChange,
  recordLapses,
  snapshotSubscriptions,
  subscriptionChanges,
  writeEntries,
} from './audit.ts'
import { settleable } from './balance.ts'
import { ChipIns } from './chip-ins.ts'
import { Coupons } from './coupons.ts'
import { EarlyHolds, holdPaid, type PlanOffer, planOwn } from './early-holds.ts'
import { SubscriptionEnding } from './ending.ts'
import { auditRenewal, ExtraUsage } from './extra-usage.ts'
import { Gifts, giftsAfterPaidTime } from './gifts.ts'
import { Overpayments } from './overpaid.ts'
import { OwedPayments } from './owed-payments.ts'
import {
  billingFacts,
  latestSubscription,
  PAYING,
  recordOrder,
  saveSubscription,
  settleOtherSubscriptions,
  subscriptionsLeftOut,
} from './persistence.ts'
import {
  moveToSmaller,
  onPlanPrice,
  requireNotSmaller,
  smallerRenewing,
  switchToEarly,
  upgradeInPlace,
} from './plan-moves.ts'
import { refundSecondCharge, stopSecondSubscriptions } from './second-subscriptions.ts'
import {
  accountsWithYearsEnded,
  markReminded,
  recordYear,
  recordYearEnds,
  yearsAhead,
  yearsToRemind,
} from './years.ts'

/** A checkout started, as the audit log keeps it with what the person agreed to on its page. */
function checkoutStarted(
  actor: Actor,
  userId: string,
  planKey: string,
  term: BillingTerm,
  options: { reason?: UpgradeReason; consent?: CheckoutConsent },
  product: string | undefined,
) {
  return {
    actor: requestedBy(actor),
    action: 'billing.checkout_started',
    subjectType: 'account',
    subjectId: userId,
    data: {
      plan: planKey,
      // A year is said; the month, as every checkout before years, isn't.
      ...(term === 'year' ? { term } : {}),
      reason: options.reason ?? 'account',
      ...(product === undefined ? {} : { early: true }),
      ...(options.consent === undefined
        ? {}
        : { terms: options.consent.terms, startNow: options.consent.startNow }),
    },
  }
}

/** The provider's word on the subscription that pays, as `saveSubscription` keeps it. */
function savedOf(
  userId: string,
  provider: string,
  externalCustomerId: string,
  paid: NonNullable<BillingState['subscription']>,
): Parameters<typeof saveSubscription>[1] {
  return {
    userId,
    provider,
    externalCustomerId,
    externalSubscriptionId: paid.externalSubscriptionId,
    planKey: paid.planKey,
    status: paid.status,
    currentPeriodEnd: paid.currentPeriodEnd,
    cancelAtPeriodEnd: paid.cancelAtPeriodEnd,
    ...(paid.createdAt === undefined ? {} : { createdAt: paid.createdAt }),
    canceledAt: paid.canceledAt ?? null,
    ...(paid.productId === undefined ? {} : { productId: paid.productId, terms: paid.terms ?? null }),
  }
}

/** A day as refusals say it: "26 October 2027". */
const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
const day = (at: Date) => DAY.format(at)

/**
 * Refused past `AbuseLimits.refreshesPerMinute` asks for one account's standing in a minute: the
 * account page asks once on coming back from a checkout or the portal.
 */
async function refreshAllowed(limits: Limits, userId: string): Promise<void> {
  if (!(await limits.allow(`billing-refresh:${userId}`, tuning().abuse.refreshesPerMinute)))
    throw new AppError('rate_limited', 'That’s a lot of checks at once. Wait a minute, then try again.')
}

/**
 * Paid plans: checkout and the customer portal through the billing provider, and the
 * provider's word on who pays for what, kept in `billing_subscriptions`. The plan in force follows
 * from it (`loadStanding`), and whatever a smaller plan no longer allows stops.
 */
export class BillingService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #caps: DeploymentCapabilities
  readonly #accounts: AccountService
  readonly #jobs: JobQueue
  readonly #mailer: Mailer
  readonly #limits: Limits
  /** Extra play, counted and sent to the provider to be billed (`extra-play-report`). */
  readonly usage: ExtraUsage
  /** Coupon codes, made and deleted by admins. */
  readonly coupons: Coupons
  /** Friends chipping in hours of play to a server. */
  readonly chipIns: ChipIns
  /** Time on a plan bought for someone else, redeemed with a code. */
  readonly gifts: Gifts
  /** Money paid that was owed no more, refunded at once. */
  readonly #overpaid: Overpayments
  /** Subscriptions Blockly ends at the provider itself: a withdrawal, a renewal left unpaid. */
  readonly #ending: SubscriptionEnding
  /** Payments that failed, and what is owed from them. */
  readonly #owed: OwedPayments
  /** The price a checkout will charge, held while its page is open. */
  readonly #holds: EarlyHolds
  readonly #webOrigin: string
  /** Where the web app's account page is, for the provider to send people back to. */
  readonly #returnUrl: string

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    capabilities: DeploymentCapabilities
    accounts: AccountService
    jobs: JobQueue
    mailer: Mailer
    limits: Limits
    webOrigin: string
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#caps = deps.capabilities
    this.#accounts = deps.accounts
    this.#jobs = deps.jobs
    this.#mailer = deps.mailer
    this.#limits = deps.limits
    this.usage = new ExtraUsage({ db: deps.db, billing: deps.capabilities.billing })
    this.coupons = new Coupons({ db: deps.db, capabilities: deps.capabilities })
    this.chipIns = new ChipIns({
      db: deps.db,
      policy: deps.policy,
      capabilities: deps.capabilities,
      webOrigin: deps.webOrigin,
    })
    this.gifts = new Gifts(deps)
    this.#overpaid = new Overpayments(deps)
    this.#ending = new SubscriptionEnding(deps)
    this.#owed = new OwedPayments(deps)
    this.#holds = new EarlyHolds(deps)
    this.#webOrigin = deps.webOrigin
    // The page reads the provider's word when people come back, before the webhook arrives.
    this.#returnUrl = new URL('/account?from=billing', deps.webOrigin).toString()
  }

  /**
   * A checkout for a paid plan. The provider sends the person back to their account page, and
   * from there on to `next`, where they were when they chose to pay; `reason` is what they
   * reached for, kept so Blockly knows why people pay. `consent` is the person's
   * agreement from the checkout page (the Terms, and that the plan starts at once), which the
   * API requires and the audit log keeps. `term: 'year'` is a year paid at once, which never
   * renews: bought on the plan already, it renews it, starting when the time paid for ends.
   */
  async startCheckout(
    actor: Actor,
    planKey: string,
    options: {
      term?: BillingTerm
      reason?: UpgradeReason
      next?: string
      consent?: CheckoutConsent
      /** The price a month the checkout page showed, which the checkout must charge. */
      priceCents?: number
    } = {},
  ): Promise<{ url: string }> {
    const user = await this.#person(actor)
    const term = options.term ?? 'month'
    if (!PAID_PLANS.includes(planKey))
      throw new AppError('invalid_choice', `There is no ${planKey} plan to buy.`)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    // A plan with no product here yet isn't for sale: said, never a failure.
    if (!requireCapability(this.#caps, 'billing').sells(planKey))
      throw new AppError('invalid_choice', `${planName(planKey)} isn’t available yet.`)
    const standing = await loadStanding(this.#db, user.id)
    const plan = entitlementsFor(planKey)
    if (term === 'month' && standing.plan === planKey)
      throw new AppError('invalid_choice', `You are on ${planKey} already.`)
    await requireNotSmaller(this.#db, user.id, standing.plan, planKey)
    if (term === 'year') await this.#mayBuyYear(user.id, planKey)
    // Money still owed from a payment that failed is paid first, in the portal: a new
    // subscription would start a new bill beside the one nobody paid.
    const { owedCents } = await billingFacts(this.#db, user.id)
    if (owedCents > 0)
      throw new AppError(
        'payment_due',
        `You owe ${dollars(owedCents)} from a payment that didn’t go through. Pay it on your account first.`,
      )
    const billing = requireCapability(this.#caps, 'billing')
    const returnUrl = new URL(this.#returnUrl)
    const next = sameSitePath(options.next)
    if (next !== null) returnUrl.searchParams.set('next', next)
    const offer = await this.#offerFor(user.id, planKey, term, options.priceCents)
    const product = offer?.productId ?? undefined
    // The subscription that pays for a smaller plan becomes this one: nothing renews beside it.
    if (offer && (await upgradeInPlace(this.#db, billing, user.id, planKey, actor, this.#reach, product))) {
      await this.refresh(actor, false)
      return { url: returnUrl.toString() }
    }
    const url = await this.#reach(() =>
      billing.checkoutUrl({
        userId: user.id,
        email: user.email,
        planKey,
        term,
        priceCents: offer?.priceCents ?? plan.yearlyPriceCents ?? plan.monthlyPriceCents,
        ...(product === undefined ? {} : { productId: product }),
        returnUrl: returnUrl.toString(),
      }),
    )
    await this.#db
      .insert(schema.auditLog)
      .values(checkoutStarted(actor, user.id, planKey, term, options, product))
    return { url }
  }

  /**
   * What a checkout will charge: for a month, the price its page showed and holds
   * (`EarlyHolds.offer`), refused when it is no longer that price so the page shows the new one
   * before any payment; for a year, null, and any hold for a month is let go.
   */
  async #offerFor(
    userId: string,
    planKey: string,
    term: BillingTerm,
    shown?: number,
  ): Promise<PlanOffer | null> {
    if (term === 'year') {
      await this.#holds.release(userId)
      return null
    }
    const offer = await this.#holds.offer(userId, planKey)
    if (shown !== undefined && shown !== offer.priceCents)
      throw new AppError(
        'invalid_choice',
        `${planName(planKey)} is ${dollars(offer.priceCents)} a month now. Check the price, then continue.`,
      )
    return offer
  }

  /**
   * What a month of `planKey` charges the person if they buy it now, held for their checkout page
   * (`EarlyHolds.offer`). Their own plan isn't one they buy, and is answered at its own price.
   */
  async offer(actor: Actor, planKey: string): Promise<PlanOffer> {
    const user = await this.#person(actor)
    if (!PAID_PLANS.includes(planKey))
      throw new AppError('invalid_choice', `There is no ${planKey} plan to buy.`)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    if ((await loadStanding(this.#db, user.id)).plan === planKey) return planOwn(planKey)
    return this.#holds.offer(user.id, planKey)
  }

  /**
   * A year of the plan is sold here and can be bought now: not while a year paid ahead still waits
   * to start, so one is never bought twice by mistake.
   */
  async #mayBuyYear(userId: string, planKey: string): Promise<void> {
    const name = planName(planKey)
    if (entitlementsFor(planKey).yearlyPriceCents === null)
      throw new AppError('invalid_choice', `${name} isn’t sold by the year.`)
    const billing = requireCapability(this.#caps, 'billing')
    if (!(await this.#reach(() => billing.sellsYear(planKey))))
      throw new AppError('invalid_choice', `A year of ${name} can’t be bought here yet.`)
    const now = new Date()
    const waiting = (await yearsAhead(this.#db, userId, now)).find((year) => year.startsAt > now)
    if (waiting !== undefined)
      throw new AppError(
        'invalid_choice',
        `Your next year of ${name} is paid for already. It starts on ${day(waiting.startsAt)}.`,
      )
  }

  /**
   * A payment for what the account owes that the provider can no longer collect on its own (its
   * subscription ended); paying it clears the block when the provider's word arrives.
   */
  async settleBalance(actor: Actor): Promise<{ url: string }> {
    const user = await this.#person(actor)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    const owed = await settleable(this.#db, user.id)
    if (owed.cents === 0)
      throw new AppError(
        'invalid_choice',
        'Nothing to pay here. A payment still being tried is paid in Manage billing.',
      )
    const billing = requireCapability(this.#caps, 'billing')
    const url = await this.#reach(() =>
      billing.settleUrl({
        userId: user.id,
        email: user.email,
        cents: owed.cents,
        settles: owed.orders,
        returnUrl: this.#returnUrl,
      }),
    )
    await this.#db.insert(schema.auditLog).values({
      actor: requestedBy(actor),
      action: 'billing.balance_payment_started',
      subjectType: 'account',
      subjectId: user.id,
      data: { cents: owed.cents, totalCents: owed.totalCents, orders: owed.orders },
    })
    return { url }
  }

  /**
   * Plus down to Core and the like: at the month's end, Plus until then (`plan-moves.ts`), at the
   * price a month the page showed (`priceCents`, as `offer` answered it).
   */
  async moveToSmaller(
    actor: Actor,
    planKey: string,
    priceCents?: number,
  ): Promise<{ plan: string; at: Date }> {
    const user = await this.#person(actor)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    const billing = requireCapability(this.#caps, 'billing')
    const offer = await this.#offerFor(user.id, planKey, 'month', priceCents)
    const product = offer?.productId ?? undefined
    try {
      const moved = await moveToSmaller(
        this.#db,
        billing,
        user.id,
        planKey,
        actor,
        (call) => this.#reach(call),
        product,
      )
      // Its early month starts when the move applies: the hold counts until the room is set from
      // figures read after then, which count the subscription on its new product.
      if (product) await this.#db.transaction((tx) => holdPaid(tx, user.id, product, moved.at))
      return moved
    } catch (error) {
      await this.#holds.release(user.id)
      throw error
    }
  }

  /**
   * What a month of each paid plan sold here charges a new subscriber now, for the pricing page:
   * its early price while the room takes that checkout and two more, so a card rarely shows a
   * price its checkout can't give, or its own (`EarlyHolds.peek`). Holds nothing.
   */
  async liveOffers(): Promise<PublicOffer[]> {
    const billing = this.#caps.billing
    if (!billing) return []
    const sold = PAID_PLANS.filter((plan) => billing.sells(plan))
    const offers = await Promise.all(sold.map((plan) => this.#holds.peek(plan, 2)))
    return offers.map((offer) => ({
      plan: offer.planKey,
      priceCents: offer.priceCents,
      includedHours: offer.includedUnits,
    }))
  }

  /**
   * The early price of the person's own plan, where their monthly subscription pays its own price
   * and the plan has one now (`EarlyHolds.peek`); null otherwise. Holds nothing.
   */
  async switchable(actor: Actor): Promise<PlanOffer | null> {
    const user = await this.#person(actor)
    const billing = this.#caps.billing
    const sub = billing ? await onPlanPrice(this.#db, billing, user.id) : null
    if (sub === null) return null
    const offer = await this.#holds.peek(sub.planKey)
    return offer.productId === null ? null : offer
  }

  /** The person's subscription takes its plan's early price now, at the price their page showed. */
  async switchPrice(actor: Actor, priceCents: number): Promise<void> {
    const user = await this.#person(actor)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    const billing = requireCapability(this.#caps, 'billing')
    const sub = await onPlanPrice(this.#db, billing, user.id)
    if (sub === null)
      throw new AppError('invalid_choice', 'Your plan isn’t one that can change its price now.')
    const offer = await this.#holds.offer(user.id, sub.planKey)
    try {
      if (offer.productId === null || offer.priceCents !== priceCents)
        throw new AppError('invalid_choice', 'That price isn’t open any more. Your plan stays as it is.')
      await switchToEarly(this.#db, billing, user.id, offer.productId, actor, this.#reach)
    } catch (error) {
      // A switch that didn't happen gives its room back, as a refused move does.
      await this.#holds.release(user.id)
      throw error
    }
    await this.refresh(actor, false)
  }

  /** The provider's page for changing or cancelling a subscription. */
  async customerPortal(actor: Actor): Promise<{ url: string }> {
    const user = await this.#person(actor)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    if ((await latestSubscription(this.#db, user.id)) === null)
      throw new AppError('invalid_choice', 'You have no subscription to manage yet.')
    const billing = requireCapability(this.#caps, 'billing')
    const url = await this.#reach(() => billing.portalUrl({ userId: user.id, returnUrl: this.#returnUrl }))
    return { url }
  }

  /** The provider's word now, on coming back from a checkout before its webhook (`refreshAllowed`). */
  async refresh(actor: Actor, counted = true): Promise<void> {
    const user = await this.#person(actor)
    if (counted) await refreshAllowed(this.#limits, user.id)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    const state = await this.#reach(() => requireCapability(this.#caps, 'billing').stateOf(user.id))
    // Never a customer: nothing pays for a plan.
    await this.syncSubscription(state ?? { userId: user.id, subscription: null }, requestedBy(actor), 'user')
  }

  /**
   * One webhook delivery, from its raw body. An authentic one that reports a standing is synced,
   * and one that reports an order is kept as revenue; one that isn't authentic is a
   * WebhookRejected for the route to refuse.
   */
  async receiveWebhook(
    body: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<'synced' | 'recorded' | 'ignored'> {
    const billing = requireCapability(this.#caps, 'billing')
    const event = await billing.receive(body, headers)
    if (event === null) return 'ignored'
    if (event.kind === 'order') {
      const kept = await recordOrder(this.#db, billing.provider, event.order)
      if (kept !== null) await this.#orderKept(billing.provider, kept)
      return kept !== null ? 'recorded' : 'ignored'
    }
    await this.syncSubscription(event.state, 'system:billing', 'webhook')
    return 'synced'
  }

  /**
   * What an order the provider's word kept (`recordOrder`) means: a balance paid, hours chipped in,
   * a renewal, a year or a gift paid for, a month withdrawn, and the account's limits read again.
   */
  async #orderKept(provider: string, order: BillingOrder): Promise<void> {
    // A gift a guest bought is the gift's alone: no account to settle, renew, refund or limit.
    if (order.userId === null) return this.gifts.received(provider, order)
    await this.#overpaid.balancePaid(order)
    await this.#overpaid.paidTwice(order)
    await refundSecondCharge(this.#db, this.#caps, order)
    await this.chipIns.record(provider, order)
    await auditRenewal(this.#db, provider, order)
    if (order.paysForYear) await this.#yearPaid(order)
    await this.gifts.received(provider, order)
    await this.#ending.refunded(order)
    // An order paid can clear what was owed; one left unpaid can be what is owed now.
    if (order.userId !== null) await this.#accounts.enforceLimits(order.userId)
  }

  /**
   * A year's order, as the provider says it now (`recordYear`): the year it pays for, made or
   * shortened by a refund, audited with the plan change it made. A subscription that still renews
   * beside it is set to end when its paid month does, which is when the year starts: one plan is
   * never paid for twice. Its standing is read again then, so the account page says so at once.
   */
  async #yearPaid(order: BillingOrder): Promise<void> {
    const userId = order.userId
    if (userId === null) return
    const billing = requireCapability(this.#caps, 'billing')
    await this.#db.transaction(async (tx) => {
      if ((await lockStanding(tx, userId)) === null) return
      const now = new Date()
      const before = (await loadStanding(tx, userId, now)).plan
      const entries = await recordYear(tx, billing.provider, order)
      if (entries === null || entries.length === 0) return
      const after = (await loadStanding(tx, userId, now)).plan
      await writeEntries(tx, userId, 'system:billing', 'webhook', [...entries, ...planChange(before, after)])
      if (after !== before) await this.#jobs.enqueueEligibility(await listingsOfOwner(tx, userId), tx)
    })
    // Asked on every delivery of it while the year is still to run, so a provider that didn't
    // answer the first time is asked again when it delivers the order again.
    const ahead = await yearsAhead(this.#db, userId, new Date())
    if (ahead.some((year) => year.externalOrderId === order.externalOrderId)) {
      const renewing = await latestSubscription(this.#db, userId)
      if (
        renewing !== null &&
        renewing.provider === billing.provider &&
        PAYING.includes(renewing.status) &&
        !renewing.cancelAtPeriodEnd
      ) {
        await billing.stopRenewing(renewing.externalSubscriptionId)
        const state = await billing.stateOf(userId)
        await this.syncSubscription(state ?? { userId, subscription: null }, 'system:billing', 'webhook')
      }
    }
    await this.#accounts.enforceLimits(userId)
  }

  /**
   * The provider's view of an account replaces ours: its paying subscription is saved, every
   * other one is ended or, where its renewal failed and the provider still retries it, past due
   * (the plan lasts a grace period then, and one past it is ended at the provider), and what the
   * resulting plan no longer allows stops.
   */
  async syncSubscription(state: BillingStanding, by: string, source: BillingSource): Promise<void> {
    const [user] = await this.#db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, state.userId))
    // A customer this deployment doesn't know (another environment's, or deleted) is not ours.
    if (!user) return
    const billing = requireCapability(this.#caps, 'billing')
    const provider = billing.provider
    const keep = state.subscription?.externalSubscriptionId ?? null
    // A standing lists only what pays now; the provider says which of the rest failed to renew.
    const pastDue = new Map<string, Date>()
    for (const id of await subscriptionsLeftOut(this.#db, state.userId, provider, keep)) {
      const since = await this.#reach(() => billing.pastDueSince(id))
      if (since !== null) pastDue.set(id, since)
    }
    await this.#stopSmallerPlans(state, provider)
    await this.#db.transaction(async (tx) => {
      // One change to an account's billing at a time, so each is audited against the one before.
      await lockStanding(tx, state.userId)
      const now = new Date()
      // Time that ran out before this word arrived is its own change, recorded first.
      await recordLapses(tx, state.userId, by, source, now)
      const before = {
        plan: (await loadStanding(tx, state.userId, now)).plan,
        subs: await snapshotSubscriptions(tx, state.userId),
      }
      const paid = state.subscription
      if (paid !== null && state.externalCustomerId !== undefined)
        await saveSubscription(tx, savedOf(state.userId, provider, state.externalCustomerId, paid))
      // A subscription on an early product is what its account's hold became.
      if (paid?.terms && paid.productId) await holdPaid(tx, state.userId, paid.productId, now)
      await settleOtherSubscriptions(tx, state.userId, provider, keep, pastDue)
      // Kept renewing over a gift redeemed to start when it ended: the gift waits for the paid time.
      const giftsMoved =
        paid !== null && !paid.cancelAtPeriodEnd
          ? await giftsAfterPaidTime(tx, state.userId, paid.currentPeriodEnd, now)
          : []
      const after = (await loadStanding(tx, state.userId, now)).plan
      await writeEntries(tx, state.userId, by, source, [
        ...subscriptionChanges(before.subs, await snapshotSubscriptions(tx, state.userId)),
        ...planChange(before.plan, after, { cancelAtPeriodEnd: paid?.cancelAtPeriodEnd ?? false }),
        ...giftsMoved,
      ])
      // Polar's word that a paid plan is in force, kept once per account and plan. Its word only:
      // a refresh after checkout may have saved the plan before this delivery came.
      if (source === 'webhook' && paid !== null)
        await noteOnce(tx, {
          event: FUNNEL.planUpgraded,
          subject: `${state.userId}:${paid.planKey}`,
          userId: state.userId,
          properties: { plan: paid.planKey },
          at: now,
        })
      // Whether a plan lists publicly is an eligibility input (§15.3).
      await this.#jobs.enqueueEligibility(await listingsOfOwner(tx, state.userId), tx)
    })
    await this.#ending.unpaid(source, new Date(), state.userId)
    await this.#accounts.enforceLimits(state.userId)
  }

  /**
   * A smaller plan's subscription still renewing beside a larger one (Plus bought by a year, or at a checkout
   * begun before Core became Plus in place) is set to end with the month it paid for; so is a second one for
   * time paid already, refunded (`second-subscriptions.ts`). A refusal to end one fails the sync, sent again.
   */
  async #stopSmallerPlans(state: BillingStanding, provider: string) {
    if (state.subscription === null) return
    const billing = requireCapability(this.#caps, 'billing')
    for (const id of await smallerRenewing(this.#db, state.userId, provider, state.subscription)) {
      await this.#reach(() => billing.stopRenewing(id))
    }
    await stopSecondSubscriptions(this.#db, billing, state, this.#reach)
  }

  /**
   * `standing-sweep`: paid time that ran out with no word from the provider (a period
   * past its renewal grace, a failed renewal past its own) drops the plan by the clock alone, so
   * nothing else would record it. Each such lapse is audited once, with the plan change it made,
   * and what the smaller plan no longer allows stops. Answers how many were recorded.
   */
  async recordLapses(now = new Date()): Promise<number> {
    let recorded = 0
    const accounts = new Set([
      ...(await accountsWithLapses(this.#db, now)),
      ...(await accountsWithYearsEnded(this.#db, now)),
    ])
    for (const userId of accounts) {
      const found = await this.#db.transaction(async (tx) => {
        await lockStanding(tx, userId)
        return (
          (await recordLapses(tx, userId, 'system:billing', 'scheduled', now)) +
          (await recordYearEnds(tx, userId, 'system:billing', 'scheduled', now))
        )
      })
      if (found > 0) await this.#accounts.enforceLimits(userId)
      recorded += found
    }
    return recorded
  }

  /**
   * `standing-sweep`'s billing, before what it stops: paid time that ran out with no word from the
   * provider, audited (`recordLapses`), and gifted time that ran out (`Gifts.recordEnds`); a
   * renewal still unpaid past its grace, ended at the provider (`SubscriptionEnding.unpaid`); then
   * owners told about payments that failed, and about years about to end. Answers how many lapses
   * were recorded.
   */
  async sweep(now = new Date()): Promise<number> {
    const lapsed = (await this.recordLapses(now)) + (await this.gifts.recordEnds(now))
    await this.#ending.unpaid('scheduled', now)
    await this.tellAboutPayments(now)
    await this.remindYears(now)
    return lapsed
  }

  /**
   * Tells each owner whose last year paid at once is ending, 14 days before and again 3 days
   * before, that it doesn't renew on its own and how to renew it (`yearsToRemind`). Answers how
   * many emails went.
   */
  async remindYears(now = new Date()): Promise<number> {
    let told = 0
    for (const year of await yearsToRemind(this.#db, now)) {
      const to = await emailOf(this.#db, year.userId)
      const yearlyCents = entitlementsFor(year.planKey).yearlyPriceCents
      if (to !== null && yearlyCents !== null) {
        await this.#mailer.send({
          to,
          ...yearEnding({
            plan: planName(year.planKey),
            endsAt: year.endsAt,
            days: year.days,
            yearlyCents,
            origin: this.#webOrigin,
          }),
        })
        told++
      }
      await markReminded(this.#db, year)
    }
    return told
  }

  /** Payments that failed and are owed: told once each, and checked with the provider first. */
  tellAboutPayments = (now = new Date()) => this.#owed.tellAboutPayments(now)
  confirmOwed = (now = new Date()) => this.#owed.confirmOwed(now)

  async #person(actor: Actor): Promise<{ id: string; email: string }> {
    if (actor.kind === 'system' || actor.kind === 'operator') throw new NotFound('Account')
    const [user] = await this.#db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, actor.userId))
    if (!user) throw new NotFound('Account')
    // A test account never reaches the billing provider: its plan is given on the admin pages.
    if (await isTestAccount(this.#db, user.id))
      throw new AppError(
        'invalid_choice',
        'This is a test account: it never pays, and its plan is set by an admin.',
      )
    return user
  }

  /** The provider being down is a refusal people can read, not an internal error. */
  async #reach<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (error instanceof BillingUnavailable)
        throw new AppError(
          'billing_unavailable',
          'Payments are not answering right now. Try again in a minute.',
        )
      throw error
    }
  }
}
