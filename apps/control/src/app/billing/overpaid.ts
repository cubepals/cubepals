// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Money paid that was owed no more, given back through the provider at once and audited, as each
 * order's word is kept (`BillingService`): what a balance order paid past what was still owed, and
 * an order a balance paid in its place that was charged after all. Which orders those are is
 * `balance.ts`'s.
 */
import type { Db } from '@blockly/db'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import type { BillingOrder } from '../ports/optional.ts'
import { auditPaidTwice, auditRefund, claimRefund, paidTwice, releaseRefund, settleWith } from './balance.ts'

export class Overpayments {
  readonly #db: Db
  readonly #caps: DeploymentCapabilities

  constructor(deps: { db: Db; capabilities: DeploymentCapabilities }) {
    this.#db = deps.db
    this.#caps = deps.capabilities
  }

  /**
   * A balance order's word (`settleWith`): what it paid past what was still owed, the same orders
   * paid twice or paid by card since, is refunded through the provider at once, and audited. It is
   * settled and its refund claimed in one transaction, under the lock `settleWith` takes on the
   * order, so deliveries of it handled at once never both read the debt as open.
   */
  async balancePaid(order: BillingOrder): Promise<void> {
    const billing = requireCapability(this.#caps, 'billing')
    const refundCents = await this.#db.transaction(async (tx) => {
      const { refundCents } = await settleWith(tx, billing.provider, order)
      if (refundCents <= 0) return 0
      return (await claimRefund(tx, billing.provider, order.externalOrderId)) ? refundCents : 0
    })
    if (refundCents <= 0) return
    await this.#refundClaimed(order.externalOrderId, refundCents, 'Paid for orders that were already paid.')
    await auditRefund(this.#db, order, refundCents)
  }

  /**
   * An order a balance paid in its place, charged after all (`paidTwice`): the charge is refunded
   * through the provider at once, and audited. The balance stands, so it is paid for once.
   */
  async paidTwice(order: BillingOrder): Promise<void> {
    const billing = requireCapability(this.#caps, 'billing')
    const { refundCents, settledBy } = await paidTwice(this.#db, billing.provider, order)
    if (settledBy === null || refundCents <= 0) return
    if (!(await claimRefund(this.#db, billing.provider, order.externalOrderId))) return
    await this.#refundClaimed(order.externalOrderId, refundCents, 'Paid already, as a balance.')
    await auditPaidTwice(this.#db, order, settledBy, refundCents)
  }

  /**
   * Gives `cents` of the order back through the provider, its refund claimed already
   * (`claimRefund`). One the provider doesn't take is released, and asked for again when it
   * delivers the order again.
   */
  async #refundClaimed(externalOrderId: string, cents: number, why: string): Promise<void> {
    const billing = requireCapability(this.#caps, 'billing')
    try {
      await billing.refund({ externalOrderId, cents, why })
    } catch (error) {
      await releaseRefund(this.#db, billing.provider, externalOrderId)
      throw error
    }
  }
}
