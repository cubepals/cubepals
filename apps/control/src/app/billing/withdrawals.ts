// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cancelling a purchase within 14 days of buying it, from the account page: the online way to
 * withdraw that UK and EU law asks for, beside emailing support. A request is kept once per order
 * (`billing_withdrawals`), with the hours played and what the Refunds page's rule gives back as
 * they stood then, and in the same transaction the purchase stops, the way a refund from the
 * provider already stops it (`purchase-stop.ts`); a first month's subscription is ended at the
 * provider first, so it never renews, and its other charges of the 14 days (an upgrade paid at
 * once) are cancelled and refunded with it, since the subscription ends whole. It also sends each
 * paid order's confirmation, which says how to cancel (`purchase-confirmation.ts`). The operator and
 * the person are told only once the request is kept, each once, and the billing pass tells whatever
 * couldn't be then, and sends any confirmation still unsent (`withdrawal-mail.ts`).
 *
 * A failure after the provider ended the subscription is reported with its order, for the plan is
 * gone there while no request is kept; asking again from the account page then keeps it.
 *
 * It never pays money out: a person refunds the order at the provider by hand, or refuses it there.
 * The refund's own delivery then ends nothing twice (`years.ts`, `gifts.ts`, `ending.ts` read the
 * request or the end it made). It is not where purchases are found or amounts worked out
 * (`withdrawable.ts`).
 */
import type { WithdrawalView } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import { sql } from 'drizzle-orm'
import { emailOf, lockStanding } from '../accounts/persistence.ts'
import type { AccountService } from '../accounts/service.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { AppError, inFull, NotFound } from '../errors.ts'
import { listingsOfOwner } from '../listings/persistence.ts'
import type { Insight } from '../ports/insight.ts'
import type { JobQueue } from '../ports/jobs.ts'
import { type BillingOrder, BillingUnavailable } from '../ports/optional.ts'
import type { Mailer } from '../ports/platform.ts'
import { writeEntries } from './audit.ts'
import { WITHDRAWAL_MS } from './ending.ts'
import { confirmPurchase, confirmUnsent } from './purchase-confirmation.ts'
import { stopPurchase } from './purchase-stop.ts'
import { alsoTitle, assess, type Purchase, purchaseHeld, purchasesOf, purchaseTitle } from './withdrawable.ts'
import { tenths, WithdrawalMail } from './withdrawal-mail.ts'
import {
  keepWithdrawal,
  type WithdrawalRecord,
  withdrawalOf,
  withdrawalsSince,
} from './withdrawal-records.ts'

/** A day as refusals say it: "26 October 2027". */
const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

export class Withdrawals {
  readonly #db: Db
  readonly #caps: DeploymentCapabilities
  readonly #accounts: AccountService
  readonly #jobs: JobQueue
  readonly #mailer: Mailer
  readonly #webOrigin: string
  readonly #insight: Insight | null
  /** Telling the operator and the person, once the request is kept. */
  readonly mail: WithdrawalMail

  constructor(deps: {
    db: Db
    capabilities: DeploymentCapabilities
    accounts: AccountService
    jobs: JobQueue
    mailer: Mailer
    webOrigin: string
    /** ADMIN_ALERT_EMAILS; empty or absent, every admin's own email. */
    adminInbox?: readonly string[]
  }) {
    this.#db = deps.db
    this.#caps = deps.capabilities
    this.#accounts = deps.accounts
    this.#jobs = deps.jobs
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
    this.#insight = deps.capabilities.insight ?? null
    this.mail = new WithdrawalMail({
      db: deps.db,
      mailer: deps.mailer,
      webOrigin: deps.webOrigin,
      inbox: deps.adminInbox ?? [],
      insight: deps.capabilities.insight ?? null,
    })
  }

  /**
   * The buyer of an order just paid told what they bought, once (`purchase-confirmation.ts`). An
   * email that fails is reported and never thrown at the provider's delivery: the order is kept
   * either way, and the billing pass sends the confirmation (`sendUnsent`).
   */
  async confirm(provider: string, order: BillingOrder): Promise<void> {
    try {
      await confirmPurchase(this.#confirming, provider, order.externalOrderId)
    } catch (error) {
      this.#report(`confirming order ${order.externalOrderId}`, error, { order: order.externalOrderId })
    }
  }

  /**
   * The billing pass: confirmations of purchases still unsent, then requests still untold, each
   * sent now. One that fails again is reported and waits for the next pass.
   */
  async sendUnsent(): Promise<void> {
    const billing = this.#caps.billing
    if (billing !== null)
      await confirmUnsent(this.#confirming, billing.provider, (order, error) =>
        this.#report(`confirming order ${order}`, error, { order }),
      )
    await this.mail.tellUntold()
  }

  get #confirming() {
    return { db: this.#db, mailer: this.#mailer, webOrigin: this.#webOrigin }
  }

  #report(doing: string, error: unknown, properties: Record<string, string>): void {
    console.error(`billing: ${doing} failed: ${inFull(error)}`)
    this.#insight?.exception(error, { properties })
  }

  /**
   * For the account page: each purchase of the last 14 days that can be cancelled, with what the
   * rule gives back now, and each cancelled in that time, as it was kept. None where nothing is sold.
   */
  async list(actor: Actor, now = new Date()): Promise<WithdrawalView[]> {
    const userId = person(actor)
    const billing = this.#caps.billing
    if (billing === null) return []
    const since = new Date(now.getTime() - WITHDRAWAL_MS)
    const asked = await withdrawalsSince(this.#db, userId, since)
    const open = (await purchasesOf(this.#db, billing.provider, { userId, since })).filter(
      (purchase) =>
        cancellable(purchase, now) && !asked.some((a) => a.externalOrderId === purchase.externalOrderId),
    )
    const views: WithdrawalView[] = []
    for (const purchase of open) views.push(viewOf(purchase, await assess(this.#db, purchase, now), null))
    for (const record of asked) {
      const [purchase] = await purchasesOf(this.#db, billing.provider, {
        userId,
        order: record.externalOrderId,
      })
      if (purchase !== undefined) views.push(viewOf(purchase, record, record))
    }
    return views
  }

  /**
   * Cancels one of the account's purchases, once, while its 14 days last; refused kindly for one
   * cancelled already, one past its 14 days, a renewal, or one refunded already, and not found for
   * another account's. A first month's subscription is ended at the provider first, so a failure
   * after leaves nothing that renews; the request is then kept and the purchase stopped together,
   * on the purchase as it is read again then, so a refund that arrived meanwhile refuses it.
   */
  async request(actor: Actor, order: string, now = new Date()): Promise<WithdrawalView> {
    const userId = person(actor)
    const billing = requireCapability(this.#caps, 'billing')
    const { provider } = billing
    const [first] = await purchasesOf(this.#db, provider, { userId, order })
    const found = refusedUnless(first, await withdrawalOf(this.#db, provider, order), now)
    const ended = found.kind === 'plan' ? found.externalSubscriptionId : null
    if (ended !== null) await reach(() => billing.endSubscription(ended))
    const { purchase, record, affected } = await this.#kept(actor, found, order, now).catch((error) => {
      // A refusal says why. Anything else left the plan ended at the provider with no request kept.
      if (ended !== null && !(error instanceof AppError) && !(error instanceof NotFound))
        this.#report(`keeping the cancellation of order ${order}, its subscription ended`, error, {
          order,
          subscription: ended,
        })
      throw error
    })
    // Kept and stopped: now the operator and the person are told, each once. One that fails is
    // reported and left for the billing pass, and the request stands.
    await this.mail.tell(record.provider, record.externalOrderId)
    for (const account of affected) await this.#accounts.enforceLimits(account)
    return viewOf(purchase, record, record)
  }

  /**
   * The request kept and the purchase stopped, together, on the purchase as it is read again under
   * its locks; refused when it may no longer be cancelled.
   */
  #kept(actor: Actor, found: Purchase, order: string, now: Date) {
    const userId = person(actor)
    const { provider } = found
    return this.#db.transaction(async (tx) => {
      await lockStanding(tx, userId)
      // One draw of a server's hours at a time (`ChipIns.draw`): none moves what is unplayed meanwhile.
      if (found.chipIn !== null)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`chip-in:${found.chipIn.ownerId}`}))`)
      const purchase = refusedUnless(
        await purchaseHeld(tx, provider, userId, order),
        await withdrawalOf(tx, provider, order),
        now,
      )
      const at = new Date()
      const assessed = await assess(tx, purchase, at)
      const sentTo = (await emailOf(tx, userId)) ?? ''
      const kept: WithdrawalRecord = {
        provider: purchase.provider,
        externalOrderId: purchase.externalOrderId,
        userId,
        kind: purchase.kind ?? 'plan',
        requestedAt: at,
        currency: purchase.currency,
        sentTo,
        ...assessed,
        acknowledgedAt: null,
        operatorsToldAt: null,
        alsoOrders: purchase.also.map((other) => ({
          order: other.externalOrderId,
          paidCents: other.paidCents,
          planKey: other.planKey,
          orderedAt: other.orderedAt.toISOString(),
        })),
      }
      if (!(await keepWithdrawal(tx, kept))) throw alreadyAsked(at)
      const by = requestedBy(actor)
      const stopped = await stopPurchase(tx, purchase, assessed, by, at)
      await writeEntries(tx, userId, by, 'user', [
        {
          action: 'billing.withdrawal_requested',
          data: {
            provider: purchase.provider,
            order: purchase.externalOrderId,
            kind: kept.kind,
            playedMilli: assessed.playedMilli,
            paidCents: assessed.paidCents,
            ...(kept.alsoOrders.length === 0 ? {} : { also: kept.alsoOrders.map((other) => other.order) }),
            refundCents: assessed.refundCents,
            rule: assessed.rule,
            earlierFull: assessed.earlierFull,
          },
        },
      ])
      for (const account of stopped.affected)
        await this.#jobs.enqueueEligibility(await listingsOfOwner(tx, account), tx)
      return { purchase, record: kept, affected: stopped.affected }
    })
  }
}

/** The account asking; nobody else cancels a purchase. */
function person(actor: Actor): string {
  if (actor.kind !== 'user') throw new NotFound('Account')
  return actor.userId
}

/** A purchase that can still be cancelled here: in its 14 days, and neither refunded nor voided. */
function cancellable(purchase: Purchase, now: Date): boolean {
  if (purchase.kind === null || now > purchase.until || purchase.refundedCents > 0) return false
  if (purchase.kind === 'gift') return purchase.gift !== null && purchase.gift.voidedAt === null
  if (purchase.kind === 'chip_in') return purchase.chipIn !== null && purchase.chipIn.withdrawnMilli === 0
  return true
}

const alreadyAsked = (at: Date) =>
  new AppError(
    'invalid_choice',
    `You cancelled this on ${DAY.format(at)} already. Your refund follows within 14 days of then.`,
  )

/** The purchase, when its account may cancel it now; refused, kindly, when it may not. */
function refusedUnless(purchase: Purchase | undefined, asked: WithdrawalRecord | null, now: Date): Purchase {
  if (purchase === undefined) throw new NotFound('Purchase')
  if (asked !== null) throw alreadyAsked(asked.requestedAt)
  if (purchase.kind === null)
    throw new AppError(
      'invalid_choice',
      'A renewal isn’t a new purchase, so it has no 14 days of its own. You can cancel your plan any time in Manage billing.',
    )
  if (now > purchase.until)
    throw new AppError(
      'invalid_choice',
      `The 14 days to cancel ${purchaseTitle(purchase)} ended on ${DAY.format(purchase.until)}.`,
    )
  if (!cancellable(purchase, now))
    throw new AppError('invalid_choice', `${capital(purchaseTitle(purchase))} has been refunded already.`)
  return purchase
}

const capital = (s: string) => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`

/**
 * A purchase as the account page lists it, with the amount now or as its request kept it. Its other
 * charges are those the request kept, once there is one.
 */
function viewOf(
  purchase: Purchase,
  amount: { paidCents: number; playedMilli: number; refundCents: number; rule: string },
  kept: WithdrawalRecord | null,
): WithdrawalView {
  const counts = !(purchase.kind === 'gift' && purchase.gift?.redeemedBy == null)
  const also =
    kept?.alsoOrders ??
    purchase.also.map((other) => ({
      order: other.externalOrderId,
      paidCents: other.paidCents,
      planKey: other.planKey,
      orderedAt: other.orderedAt.toISOString(),
    }))
  return {
    order: purchase.externalOrderId,
    kind: purchase.kind ?? 'plan',
    title: purchaseTitle(purchase),
    boughtAt: purchase.orderedAt.toISOString(),
    until: purchase.until.toISOString(),
    paidCents: amount.paidCents,
    refundCents: amount.refundCents,
    currency: purchase.currency,
    also: also.map((other) => ({
      order: other.order,
      title: alsoTitle(purchase, other),
      boughtAt: other.orderedAt,
      paidCents: other.paidCents,
    })),
    hoursPlayed: counts ? tenths(amount.playedMilli) : null,
    rule: amount.rule as WithdrawalView['rule'],
    requestedAt: kept?.requestedAt.toISOString() ?? null,
  }
}

/** The provider being down is a refusal people can read, not an internal error. */
async function reach<T>(call: () => Promise<T>): Promise<T> {
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
