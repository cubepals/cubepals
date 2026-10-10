import type { CheckoutConsent, UpgradeReason } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsFor, PAID_PLANS } from '../../domain/account/entitlements.ts'
import { dollars } from '../../domain/policy/spend.ts'
import { emailOf, loadStanding, lockStanding } from '../accounts/persistence.ts'
import type { AccountService } from '../accounts/service.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { paymentFailed, paymentOwed } from '../emails/billing.ts'
import { AppError, inFull, NotFound } from '../errors.ts'
import { FUNNEL, noteOnce } from '../insight/record.ts'
import { listingsOfOwner } from '../listings/persistence.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { JobQueue } from '../ports/jobs.ts'
import { type BillingOrder, type BillingState, BillingUnavailable, type OrderNow } from '../ports/optional.ts'
import type { Mailer } from '../ports/platform.ts'
import {
  accountsWithLapses,
  type BillingSource,
  planChange,
  recordLapses,
  snapshotSubscriptions,
  subscriptionChanges,
  writeEntries,
} from './audit.ts'
import { auditRefund, claimRefund, settleable, settleWith } from './balance.ts'
import { auditRenewal, ExtraUsage } from './extra-usage.ts'
import {
  billingFacts,
  failingUntold,
  latestSubscription,
  markOwed,
  markTold,
  mayBeOwed,
  owingUntold,
  PAST_DUE_GRACE_MS,
  recordOrder,
  saveSubscription,
  settleOtherSubscriptions,
  subscriptionsLeftOut,
  UNPAID_ORDER,
  untoldAbout,
} from './persistence.ts'

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
  /** Extra play, counted and sent to the provider to be billed (`extra-play-report`). */
  readonly usage: ExtraUsage
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
    webOrigin: string
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#caps = deps.capabilities
    this.#accounts = deps.accounts
    this.#jobs = deps.jobs
    this.#mailer = deps.mailer
    this.usage = new ExtraUsage({ db: deps.db, billing: deps.capabilities.billing })
    this.#webOrigin = deps.webOrigin
    // The page reads the provider's word when people come back, before the webhook arrives.
    this.#returnUrl = new URL('/account?from=billing', deps.webOrigin).toString()
  }

  /**
   * A checkout for a paid plan. The provider sends the person back to their account page, and
   * from there on to `next`, where they were when they chose to pay; `reason` is what they
   * reached for, kept so Blockly knows why people pay. `consent` is the person's
   * agreement from the checkout page (the Terms, and that the plan starts at once), which the
   * API requires and the audit log keeps.
   */
  async startCheckout(
    actor: Actor,
    planKey: string,
    options: { reason?: UpgradeReason; next?: string; consent?: CheckoutConsent } = {},
  ): Promise<{ url: string }> {
    const user = await this.#person(actor)
    if (!PAID_PLANS.includes(planKey))
      throw new AppError('invalid_choice', `There is no ${planKey} plan to buy.`)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    const standing = await loadStanding(this.#db, user.id)
    if (standing.plan === planKey) throw new AppError('invalid_choice', `You are on ${planKey} already.`)
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
    if (options.next !== undefined && /^\/(?![/\\])/.test(options.next))
      returnUrl.searchParams.set('next', options.next)
    const url = await this.#reach(() =>
      billing.checkoutUrl({
        userId: user.id,
        email: user.email,
        planKey,
        priceCents: entitlementsFor(planKey).monthlyPriceCents,
        returnUrl: returnUrl.toString(),
      }),
    )
    await this.#db.insert(schema.auditLog).values({
      actor: requestedBy(actor),
      action: 'billing.checkout_started',
      subjectType: 'account',
      subjectId: user.id,
      // What the person agreed to on the checkout page, kept with the checkout it started.
      data: {
        plan: planKey,
        reason: options.reason ?? 'account',
        ...(options.consent === undefined
          ? {}
          : { terms: options.consent.terms, startNow: options.consent.startNow }),
      },
    })
    return { url }
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

  /**
   * Asks the provider for the person's standing now, for when they come back from a checkout
   * before its webhook arrives.
   */
  async refresh(actor: Actor): Promise<void> {
    const user = await this.#person(actor)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    const billing = requireCapability(this.#caps, 'billing')
    const state = await this.#reach(() => billing.stateOf(user.id))
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
      if (kept) await this.#balancePaid(event.order)
      if (kept) await auditRenewal(this.#db, billing.provider, event.order)
      // An order paid can clear what was owed; one left unpaid can be what is owed now.
      if (kept && event.order.userId !== null) await this.#accounts.enforceLimits(event.order.userId)
      return kept ? 'recorded' : 'ignored'
    }
    await this.syncSubscription(event.state, 'system:billing', 'webhook')
    return 'synced'
  }

  /**
   * A balance order's word (`settleWith`): what it paid past what was still owed, the same orders
   * paid twice or paid by card since, is refunded through the provider at once, and audited.
   */
  async #balancePaid(order: BillingOrder): Promise<void> {
    const billing = requireCapability(this.#caps, 'billing')
    const { refundCents } = await settleWith(this.#db, billing.provider, order)
    if (refundCents <= 0) return
    const { claimed, release } = await claimRefund(this.#db, billing.provider, order.externalOrderId)
    if (!claimed) return
    try {
      await billing.refund({
        externalOrderId: order.externalOrderId,
        cents: refundCents,
        why: 'Paid for orders that were already paid.',
      })
    } catch (error) {
      // Not given back: the provider delivers the order again, and it is tried again then.
      await release()
      throw error
    }
    await auditRefund(this.#db, order, refundCents)
  }

  /**
   * The provider's view of an account replaces ours: its paying subscription is saved, every
   * other one is ended or, where its renewal failed and the provider still retries it, past due
   * (the plan lasts a grace period then), and what the resulting plan no longer allows stops.
   */
  async syncSubscription(
    state: Pick<BillingState, 'userId' | 'subscription'> & { externalCustomerId?: string },
    by: string,
    source: BillingSource,
  ): Promise<void> {
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
        await saveSubscription(tx, {
          userId: state.userId,
          provider,
          externalCustomerId: state.externalCustomerId,
          externalSubscriptionId: paid.externalSubscriptionId,
          planKey: paid.planKey,
          status: paid.status,
          currentPeriodEnd: paid.currentPeriodEnd,
          cancelAtPeriodEnd: paid.cancelAtPeriodEnd,
          ...(paid.createdAt === undefined ? {} : { createdAt: paid.createdAt }),
          canceledAt: paid.canceledAt ?? null,
        })
      await settleOtherSubscriptions(tx, state.userId, provider, keep, pastDue)
      const after = (await loadStanding(tx, state.userId, now)).plan
      await writeEntries(tx, state.userId, by, source, [
        ...subscriptionChanges(before.subs, await snapshotSubscriptions(tx, state.userId)),
        ...planChange(before.plan, after, { cancelAtPeriodEnd: paid?.cancelAtPeriodEnd ?? false }),
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
    await this.#accounts.enforceLimits(state.userId)
  }

  /**
   * `standing-sweep`: paid time that ran out with no word from the provider (a period
   * past its renewal grace, a failed renewal past its own) drops the plan by the clock alone, so
   * nothing else would record it. Each such lapse is audited once, with the plan change it made,
   * and what the smaller plan no longer allows stops. Answers how many were recorded.
   */
  async recordLapses(now = new Date()): Promise<number> {
    let recorded = 0
    for (const userId of await accountsWithLapses(this.#db, now)) {
      const found = await this.#db.transaction(async (tx) => {
        await lockStanding(tx, userId)
        return recordLapses(tx, userId, 'system:billing', 'scheduled', now)
      })
      if (found > 0) await this.#accounts.enforceLimits(userId)
      recorded += found
    }
    return recorded
  }

  /**
   * `standing-sweep`'s billing, before what it stops: paid time that ran out with no word from the
   * provider, audited (`recordLapses`), then owners told about payments that failed. Answers how
   * many lapses were recorded.
   */
  async sweep(now = new Date()): Promise<number> {
    const lapsed = await this.recordLapses(now)
    await this.tellAboutPayments(now)
    return lapsed
  }

  /**
   * Tells each owner, once per charge, that a payment carrying extra play
   * failed while the card is tried again, and that it is owed once it is still unpaid after that,
   * when their servers stop until it is paid. Answers how many emails went.
   */
  async tellAboutPayments(now = new Date()): Promise<number> {
    await this.confirmOwed(now)
    let told = 0
    for (const userId of await untoldAbout(this.#db)) {
      const to = await emailOf(this.#db, userId)
      told += await this.#tellFailing(userId, to, now)
      told += await this.#tellOwing(userId, to, now)
    }
    return told
  }

  /**
   * Orders that may be owed (`mayBeOwed`), each read again from the provider before the account is
   * held to owe it, so a webhook that never came never blocks someone who paid: one paid since is
   * kept as paid. The final charge of a subscription that ended is owed only once it was tried and
   * failed, or the provider voided it; one past the grace a failed renewal gets, once it is still
   * unpaid. The provider not answering leaves it for the next pass. Answers how many became owed.
   */
  async confirmOwed(now = new Date()): Promise<number> {
    let owed = 0
    for (const candidate of await mayBeOwed(this.#db, now)) {
      const fresh = await this.#orderNow(candidate.externalOrderId)
      if (fresh === null || !UNPAID_ORDER.includes(fresh.order.status)) continue
      if (candidate.ended && fresh.order.status !== 'void' && !fresh.chargeFailed) continue
      await markOwed(this.#db, candidate.provider, candidate.externalOrderId, now)
      await this.#accounts.enforceLimits(candidate.userId)
      owed++
    }
    return owed
  }

  /**
   * The order as the provider holds it now, kept as it says (paid since, or voided); null when the
   * provider doesn't know it, doesn't answer or refuses, so one order waits for the next pass
   * instead of stopping the sweep and the hours limits enforced after it.
   */
  async #orderNow(externalOrderId: string): Promise<OrderNow | null> {
    const billing = requireCapability(this.#caps, 'billing')
    const fresh = await billing.order(externalOrderId).catch((error: unknown) => {
      if (!(error instanceof BillingUnavailable))
        console.error(`billing: reading order ${externalOrderId} failed: ${inFull(error)}`)
      return null
    })
    if (fresh !== null && (await recordOrder(this.#db, billing.provider, fresh.order)))
      await settleWith(this.#db, billing.provider, fresh.order)
    return fresh
  }

  /** A charge that failed while the card is tried again: said once, with the day it is owed by. */
  async #tellFailing(userId: string, to: string | null, now: Date): Promise<number> {
    const failing = []
    // Read again first: one paid since its webhook was lost is not emailed about, and one the
    // provider doesn't answer about waits for the next pass.
    for (const order of await failingUntold(this.#db, userId)) {
      const fresh = await this.#orderNow(order.externalOrderId)
      if (fresh !== null && UNPAID_ORDER.includes(fresh.order.status)) failing.push(order)
    }
    if (to !== null)
      for (const order of failing)
        await this.#mailer.send({
          to,
          ...paymentFailed({
            totalCents: order.totalCents,
            extraCents: order.extraCents,
            by: new Date(order.orderedAt.getTime() + PAST_DUE_GRACE_MS),
            origin: this.#webOrigin,
          }),
        })
    await markTold(this.#db, failing, 'failure', now)
    return to === null ? 0 : failing.length
  }

  /** Charges now owed: said once, and the account's servers stop until they are paid. */
  async #tellOwing(userId: string, to: string | null, now: Date): Promise<number> {
    const owing = await owingUntold(this.#db, userId)
    if (owing.length === 0) return 0
    if (to !== null)
      await this.#mailer.send({
        to,
        ...paymentOwed({
          owedCents: owing.reduce((sum, order) => sum + order.totalCents, 0),
          extraCents: owing.reduce((sum, order) => sum + order.extraCents, 0),
          origin: this.#webOrigin,
        }),
      })
    // Someone told they owe needn't hear that it failed as well.
    await markTold(this.#db, owing, 'failure', now)
    await markTold(this.#db, owing, 'owing', now)
    await this.#accounts.enforceLimits(userId)
    return to === null ? 0 : 1
  }

  async #person(actor: Actor): Promise<{ id: string; email: string }> {
    if (actor.kind === 'system') throw new NotFound('Account')
    const [user] = await this.#db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, actor.userId))
    if (!user) throw new NotFound('Account')
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
