// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Telling of a purchase cancelled within its 14 days, once the request is kept: the operator, who
 * pays the refund at the provider by hand, and the person, whose acknowledgement says when it was
 * received. Each is handed over at most once: its moment on `billing_withdrawals` is set in the
 * transaction that sends it, so a send that fails leaves it unset, and two passes at once never
 * both send. The request tells right after it is kept; the billing pass (`standing-sweep`) tells
 * whatever is still untold. A failure is reported and logged, never thrown at the person: the
 * request stands either way.
 *
 * It is not where a request is made (`withdrawals.ts`), and it pays nothing.
 */
import { type Db, schema } from '@blockly/db'
import { and, eq, isNull, or } from 'drizzle-orm'
import { planName } from '../../domain/account/entitlements.ts'
import { adminInbox } from '../accounts/persistence.ts'
import { withdrawalToRefund } from '../emails/admins.ts'
import { money, whenSaid, withdrawalReceived } from '../emails/purchases.ts'
import { inFull } from '../errors.ts'
import type { Insight } from '../ports/insight.ts'
import type { Mailer } from '../ports/platform.ts'
import { type Purchase, purchasesOf, purchaseTitle } from './withdrawable.ts'
import type { WithdrawalRecord } from './withdrawal-records.ts'

const withdrawals = schema.billingWithdrawals

/** Requests told in one pass of the billing sweep, the oldest first. */
const BATCH = 50

/** Hours as the page and the emails say them: to a tenth. */
export const tenths = (milli: number) => Math.round(milli / 100) / 10

/** Which of the two a send is: its moment's column, and the email it hands over. */
type Told = 'operators' | 'person'

export class WithdrawalMail {
  readonly #db: Db
  readonly #mailer: Mailer
  readonly #webOrigin: string
  readonly #inbox: readonly string[]
  readonly #insight: Insight | null

  constructor(deps: {
    db: Db
    mailer: Mailer
    webOrigin: string
    inbox: readonly string[]
    insight: Insight | null
  }) {
    this.#db = deps.db
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
    this.#inbox = deps.inbox
    this.#insight = deps.insight
  }

  /** What of one request is still untold, told now; false when a send failed (reported, not thrown). */
  async tell(provider: string, order: string): Promise<boolean> {
    let told = true
    for (const which of ['operators', 'person'] as const) {
      try {
        await this.#send(provider, order, which)
      } catch (error) {
        told = false
        console.error(`billing: telling of cancelled order ${order} (${which}) failed: ${inFull(error)}`)
        this.#insight?.exception(error, { properties: { order, told: which } })
      }
    }
    return told
  }

  /** The billing pass: requests still untold, each told now. Answers how many are told in full. */
  async tellUntold(): Promise<number> {
    const untold = await this.#db
      .select({ provider: withdrawals.provider, order: withdrawals.externalOrderId })
      .from(withdrawals)
      .where(or(isNull(withdrawals.acknowledgedAt), isNull(withdrawals.operatorsToldAt)))
      .orderBy(withdrawals.requestedAt)
      .limit(BATCH)
    let done = 0
    for (const row of untold) if (await this.tell(row.provider, row.order)) done++
    return done
  }

  /**
   * One of the two, handed over once: its moment set under the row's lock, the email sent in the
   * same transaction, so a failed send leaves it to be tried again.
   */
  async #send(provider: string, order: string, which: Told): Promise<void> {
    const column = which === 'operators' ? withdrawals.operatorsToldAt : withdrawals.acknowledgedAt
    await this.#db.transaction(async (tx) => {
      const [record] = await tx
        .select()
        .from(withdrawals)
        .where(
          and(eq(withdrawals.provider, provider), eq(withdrawals.externalOrderId, order), isNull(column)),
        )
        .for('update')
      if (record === undefined) return
      const [purchase] = await purchasesOf(tx, provider, { order })
      if (purchase === undefined) return
      const now = new Date()
      await tx
        .update(withdrawals)
        .set(which === 'operators' ? { operatorsToldAt: now } : { acknowledgedAt: now })
        .where(and(eq(withdrawals.provider, provider), eq(withdrawals.externalOrderId, order)))
      if (which === 'operators') {
        const email = this.#toOperators(purchase, record)
        for (const to of await adminInbox(tx, this.#inbox)) await this.#mailer.send({ to, ...email })
      } else if (record.sentTo !== '')
        await this.#mailer.send({ to: record.sentTo, ...this.#toPerson(purchase, record) })
    })
  }

  #toOperators(purchase: Purchase, record: WithdrawalRecord) {
    return withdrawalToRefund({
      userId: record.userId,
      order: record.externalOrderId,
      kind: record.kind,
      title: purchaseTitle(purchase),
      receivedAt: whenSaid(record.requestedAt),
      hoursPlayed:
        purchase.kind === 'gift' && purchase.gift?.redeemedBy == null ? null : tenths(record.playedMilli),
      paid: money(record.paidCents, record.currency),
      refund: money(record.refundCents, record.currency),
      rule: record.rule,
      earlierFull: record.earlierFull,
      origin: this.#webOrigin,
    })
  }

  #toPerson(purchase: Purchase, record: WithdrawalRecord) {
    return withdrawalReceived({
      title: purchaseTitle(purchase),
      receivedAt: record.requestedAt,
      paidCents: record.paidCents,
      refundCents: record.refundCents,
      currency: record.currency,
      ended: endedSaid(purchase, record),
      origin: this.#webOrigin,
    })
  }
}

/** What the request stopped, said whole, from the purchase as it stood when it was kept. */
function endedSaid(purchase: Purchase, record: WithdrawalRecord): string {
  if (purchase.kind === 'year' && purchase.year !== null) {
    const plan = planName(purchase.year.planKey)
    return purchase.year.startsAt > record.requestedAt
      ? `Your year of ${plan} won’t start.`
      : `Your year of ${plan} has ended. Your account is on the free trial now, unless something else you paid for runs; your worlds stay.`
  }
  if (purchase.kind === 'gift')
    return purchase.gift?.redeemedBy == null
      ? 'Its code has stopped working.'
      : 'Its code has stopped working, and the time it gave the account that redeemed it has ended.'
  if (purchase.kind === 'chip_in')
    return `The ${tenths(purchase.chipIn?.withdrawnMilli ?? 0)} hours of it nobody had played can’t be played now.`
  return `${planName(purchase.planKey ?? 'plus')} has ended, and nothing more will be charged for it. Your account is on the free trial now; your worlds stay.`
}
