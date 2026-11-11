// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Telling of a purchase cancelled within its 14 days, once the request is kept: the operator, who
 * pays the refund at the provider by hand, and the person, whose acknowledgement says when it was
 * received. Each has its moment on `billing_withdrawals`, set in the transaction that sends it, so
 * a send that fails leaves it unset, and two passes at once never both send. That makes each sent
 * at least once: an email that went just before its moment failed to be kept goes again, which is
 * better than an acknowledgement the law asks for, or a refund to pay, never being told. The request
 * tells right after it is kept; the billing pass (`standing-sweep`) tells whatever is still untold,
 * the person's and the operators' apart, so one that can't be sent holds back nothing else. A
 * failure is reported and logged, never thrown at the person: the request stands either way.
 *
 * It is not where a request is made (`withdrawals.ts`), and it pays nothing.
 */
import { type Db, schema } from '@blockly/db'
import { and, eq, isNull } from 'drizzle-orm'
import { planName } from '../../domain/account/entitlements.ts'
import { adminInbox } from '../accounts/persistence.ts'
import { withdrawalToRefund } from '../emails/admins.ts'
import { money, whenSaid, withdrawalReceived } from '../emails/purchases.ts'
import { inFull } from '../errors.ts'
import type { Insight } from '../ports/insight.ts'
import type { Mailer } from '../ports/platform.ts'
import { alsoTitle, type Purchase, purchasesOf, purchaseTitle } from './withdrawable.ts'
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

  /** What of one request is still untold, told now. A send that fails is reported, not thrown. */
  async tell(provider: string, order: string): Promise<void> {
    for (const which of ['operators', 'person'] as const) await this.#try(provider, order, which)
  }

  /**
   * The billing pass: requests still untold, each told now, the oldest first. The person's and the
   * operators' are read apart, each to its own batch, and with no operator address at all the
   * operators' are left for a pass that has one, said once: requests that can't be told never fill
   * a batch ahead of ones that can.
   */
  async tellUntold(): Promise<void> {
    for (const row of await this.#untold('person')) await this.#try(row.provider, row.order, 'person')
    const waiting = await this.#untold('operators')
    if (waiting.length === 0) return
    if ((await adminInbox(this.#db, this.#inbox)).length === 0) {
      const error = new Error('no operator address to tell of cancelled purchases')
      console.error(
        `billing: ${waiting.length} or more cancelled purchases wait to be told: ${error.message}`,
      )
      this.#insight?.exception(error, { properties: { told: 'operators' } })
      return
    }
    for (const row of waiting) await this.#try(row.provider, row.order, 'operators')
  }

  #untold(which: Told) {
    return this.#db
      .select({ provider: withdrawals.provider, order: withdrawals.externalOrderId })
      .from(withdrawals)
      .where(isNull(which === 'operators' ? withdrawals.operatorsToldAt : withdrawals.acknowledgedAt))
      .orderBy(withdrawals.requestedAt)
      .limit(BATCH)
  }

  async #try(provider: string, order: string, which: Told): Promise<void> {
    try {
      await this.#send(provider, order, which)
    } catch (error) {
      console.error(`billing: telling of cancelled order ${order} (${which}) failed: ${inFull(error)}`)
      this.#insight?.exception(error, { properties: { order, told: which } })
    }
  }

  /**
   * One of the two, handed over: its moment set under the row's lock, the email sent in the same
   * transaction, so a failed send leaves it to be tried again, and one whose moment then fails to
   * be kept is sent again (at least once, as the header says).
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
      if (which === 'operators')
        await this.#toEach(await adminInbox(tx, this.#inbox), this.#toOperators(purchase, record), order)
      else if (record.sentTo !== '')
        await this.#mailer.send({ to: record.sentTo, ...this.#toPerson(purchase, record) })
    })
  }

  /**
   * The operators' email to each of their addresses. They are told once any address has it, so an
   * address that fails never has the others told again; its failure is reported. With no address,
   * or none that takes it, nobody is told and it is tried again.
   */
  async #toEach(
    addresses: readonly string[],
    email: ReturnType<typeof withdrawalToRefund>,
    order: string,
  ): Promise<void> {
    let reached = 0
    let failure: unknown = new Error('no operator address to tell of a cancelled purchase')
    for (const to of addresses) {
      try {
        await this.#mailer.send({ to, ...email })
        reached++
      } catch (error) {
        failure = error
        console.error(`billing: telling an operator of cancelled order ${order} failed: ${inFull(error)}`)
        this.#insight?.exception(error, { properties: { order, told: 'operators' } })
      }
    }
    if (reached === 0) throw failure
  }

  #toOperators(purchase: Purchase, record: WithdrawalRecord) {
    return withdrawalToRefund({
      userId: record.userId,
      order: record.externalOrderId,
      kind: record.kind,
      title: purchaseTitle(purchase),
      also: record.alsoOrders.map((other) => ({
        order: other.order,
        title: alsoTitle(purchase, other),
        paid: money(other.paidCents, record.currency),
      })),
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
      also: record.alsoOrders.map((other) => alsoTitle(purchase, other)),
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
  // The plan its subscription sold when it ended: an upgrade since the first month changed it.
  const plan = purchase.subscription?.planKey ?? purchase.planKey ?? 'plus'
  return `${planName(plan)} has ended, and nothing more will be charged for it. Your account is on the free trial now; your worlds stay.`
}
