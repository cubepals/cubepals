// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Payments that failed, as the billing service follows them up (`BillingService`): each owner told
 * once per charge that one carrying extra play failed while the card is tried again, and once that
 * it is owed, when their servers stop until it is paid; every order read again from the provider
 * before anyone is held to owe it. Which orders may be owed is `persistence.ts`'s.
 */
import { type Db, schema } from '@blockly/db'
import { planName } from '../../domain/account/entitlements.ts'
import { emailOf } from '../accounts/persistence.ts'
import type { AccountService } from '../accounts/service.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { paymentFailed, paymentOwed } from '../emails/billing.ts'
import { inFull } from '../errors.ts'
import { BillingUnavailable, type OrderNow } from '../ports/optional.ts'
import type { Mailer } from '../ports/platform.ts'
import { settleWith } from './balance.ts'
import {
  failingUntold,
  markOwed,
  markTold,
  markUnknown,
  mayBeOwed,
  owingUntold,
  PAST_DUE_GRACE_MS,
  recordOrder,
  UNPAID_ORDER,
  untoldAbout,
} from './persistence.ts'

export class OwedPayments {
  readonly #db: Db
  readonly #caps: DeploymentCapabilities
  readonly #accounts: AccountService
  readonly #mailer: Mailer
  readonly #webOrigin: string

  constructor(deps: {
    db: Db
    capabilities: DeploymentCapabilities
    accounts: AccountService
    mailer: Mailer
    webOrigin: string
  }) {
    this.#db = deps.db
    this.#caps = deps.capabilities
    this.#accounts = deps.accounts
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
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
      const fresh = await this.#orderNow(candidate.externalOrderId, now)
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
   * instead of stopping the sweep and the hours limits enforced after it. One it doesn't know is
   * marked (`markUnknown`) and read again a day later, not every pass; the first time, it is kept
   * on the account's audit log and an admin is told (`billing_order_unknown`).
   */
  async #orderNow(externalOrderId: string, now: Date): Promise<OrderNow | null> {
    const billing = requireCapability(this.#caps, 'billing')
    let fresh: OrderNow | null
    try {
      fresh = await billing.order(externalOrderId)
    } catch (error) {
      if (!(error instanceof BillingUnavailable))
        console.error(`billing: reading order ${externalOrderId} failed: ${inFull(error)}`)
      return null
    }
    if (fresh === null) {
      const userId = await markUnknown(this.#db, billing.provider, externalOrderId, now)
      if (userId !== null) {
        console.error(`billing: ${billing.provider} doesn't know order ${externalOrderId}`)
        await this.#db.insert(schema.auditLog).values({
          actor: 'system:billing',
          action: 'billing.order_unknown',
          subjectType: 'account',
          subjectId: userId,
          data: { order: externalOrderId },
        })
      }
      return null
    }
    if ((await recordOrder(this.#db, billing.provider, fresh.order)) !== null)
      await this.#db.transaction((tx) => settleWith(tx, billing.provider, fresh.order))
    return fresh
  }

  /** A charge that failed while the card is tried again: said once, with the day it is owed by. */
  async #tellFailing(userId: string, to: string | null, now: Date): Promise<number> {
    const failing = []
    // Read again first: one paid since its webhook was lost is not emailed about, and one the
    // provider doesn't answer about waits for the next pass.
    for (const order of await failingUntold(this.#db, userId, now)) {
      const fresh = await this.#orderNow(order.externalOrderId, now)
      if (fresh !== null && UNPAID_ORDER.includes(fresh.order.status)) failing.push(order)
    }
    if (to !== null)
      for (const order of failing)
        await this.#mailer.send({
          to,
          ...paymentFailed({
            plan: planName(order.planKey ?? 'plus'),
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
          plan: planName(owing[0]?.planKey ?? 'plus'),
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
}
