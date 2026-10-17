// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Blockly ending a plan's subscription at the provider itself, where the provider wouldn't: a first
 * month refunded as the withdrawal the Refunds page offers (a refund at the provider ends nothing
 * on its own), and a renewal still unpaid when the plan's grace runs out (`PAST_DUE_GRACE_MS`), so
 * the provider never takes a charge for time the account spent on the free trial. Each is ended
 * once: the provider is asked, the subscription is marked ended here, the audit log keeps why
 * (`billing.subscription_revoked`), and the owner is emailed. The account page reads why from the
 * log (`endedFor`).
 *
 * It decides no plan (`persistence.ts`), and gives no refund (`balance.ts`).
 */
import { DAY_MS } from '@blockly/contracts/durations'
import { type Db, type Queryable, schema } from '@blockly/db'
import { and, desc, eq, lte, ne, sql } from 'drizzle-orm'
import { planName } from '../../domain/account/entitlements.ts'
import { emailOf, loadStanding, lockStanding } from '../accounts/persistence.ts'
import type { AccountService } from '../accounts/service.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { planEnded } from '../emails/billing.ts'
import { inFull } from '../errors.ts'
import { listingsOfOwner } from '../listings/persistence.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { BillingOrder } from '../ports/optional.ts'
import type { Mailer } from '../ports/platform.ts'
import {
  type BillingSource,
  planChange,
  recordLapses,
  snapshotSubscriptions,
  subscriptionChanges,
  writeEntries,
} from './audit.ts'
import { PAST_DUE_GRACE_MS, type SubscriptionRecord } from './persistence.ts'

const subscriptions = schema.billingSubscriptions

/** The Refunds page's withdrawal: a first month refunded within this long of its order. */
const WITHDRAWAL_MS = 14 * DAY_MS

/** Why Blockly ended a subscription, as the audit log keeps it and the account page says it. */
export type EndedFor = 'withdrawal' | 'unpaid'

const REVOKED = 'billing.subscription_revoked'

export class SubscriptionEnding {
  readonly #db: Db
  readonly #caps: DeploymentCapabilities
  readonly #accounts: AccountService
  readonly #jobs: JobQueue
  readonly #mailer: Mailer
  readonly #webOrigin: string

  constructor(deps: {
    db: Db
    capabilities: DeploymentCapabilities
    accounts: AccountService
    jobs: JobQueue
    mailer: Mailer
    webOrigin: string
  }) {
    this.#db = deps.db
    this.#caps = deps.capabilities
    this.#accounts = deps.accounts
    this.#jobs = deps.jobs
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
  }

  /**
   * An order of a plan's subscription with a refund on it, as the provider's word kept it: when the
   * refund is the withdrawal, the subscription ends now. A first month's order refunded within 14
   * days of it is (the only refund the Refunds page offers then); any other refund only when the
   * provider's reason for it says so. A provider that doesn't answer throws, and the order's next
   * delivery asks again.
   */
  async refunded(order: BillingOrder, now = new Date()): Promise<void> {
    const sub = order.externalSubscriptionId
    if (order.userId === null || sub === null || order.planKey === null) return
    if (order.paysForYear || order.refundedCents <= 0) return
    const billing = requireCapability(this.#caps, 'billing')
    const [open] = await this.#db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, order.userId),
          eq(subscriptions.provider, billing.provider),
          eq(subscriptions.externalSubscriptionId, sub),
          ne(subscriptions.status, 'ended'),
        ),
      )
    if (open === undefined) return
    const refundedAt = order.changedAt ?? now
    const firstMonth =
      order.billingReason === 'subscription_create' &&
      refundedAt.getTime() - order.orderedAt.getTime() <= WITHDRAWAL_MS
    if (!firstMonth && !(await billing.refundedAsWithdrawal(order.externalOrderId))) return
    await this.#end(order.userId, sub, 'withdrawal', 'webhook')
  }

  /**
   * Subscriptions still past due once the plan's grace from the failed renewal has run out, of one
   * account or of all: each is ended at the provider, so a retry that succeeds later never charges
   * for the month the account spent on the free trial. One the provider says was paid since, or
   * ended, is left for its word. One the provider doesn't answer about waits for the next pass, so
   * a sync or the sweep is never stopped by it. Answers how many were ended.
   */
  async unpaid(source: BillingSource, now = new Date(), userId?: string): Promise<number> {
    const billing = requireCapability(this.#caps, 'billing')
    const cutoff = new Date(now.getTime() - PAST_DUE_GRACE_MS)
    const due = await this.#db
      .select({ userId: subscriptions.userId, id: subscriptions.externalSubscriptionId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.provider, billing.provider),
          eq(subscriptions.status, 'past_due'),
          lte(subscriptions.pastDueAt, cutoff),
          ...(userId === undefined ? [] : [eq(subscriptions.userId, userId)]),
        ),
      )
    let ended = 0
    for (const row of due) {
      try {
        const since = await billing.pastDueSince(row.id)
        if (since === null || since > cutoff) continue
        if (await this.#end(row.userId, row.id, 'unpaid', source)) ended++
      } catch (error) {
        console.error(`billing: ending unpaid subscription ${row.id} failed: ${inFull(error)}`)
      }
    }
    return ended
  }

  /**
   * Ends the subscription at the provider, then here, audited with the plan change it made, and
   * tells the owner. Only the first to mark it ended does the rest, so deliveries handled at once
   * never email twice. False when it had ended here already.
   */
  async #end(userId: string, sub: string, why: EndedFor, source: BillingSource): Promise<boolean> {
    const billing = requireCapability(this.#caps, 'billing')
    await billing.endSubscription(sub)
    const planKey = await this.#db.transaction(async (tx) => {
      await lockStanding(tx, userId)
      const now = new Date()
      // Time that ran out before it ended (a grace past) is its own change, recorded first.
      await recordLapses(tx, userId, 'system:billing', source, now)
      const before = {
        plan: (await loadStanding(tx, userId, now)).plan,
        subs: await snapshotSubscriptions(tx, userId),
      }
      const [row] = await tx
        .update(subscriptions)
        .set({
          status: 'ended',
          canceledAt: sql`coalesce(${subscriptions.canceledAt}, now())`,
          updatedAt: now,
        })
        .where(
          and(
            eq(subscriptions.userId, userId),
            eq(subscriptions.provider, billing.provider),
            eq(subscriptions.externalSubscriptionId, sub),
            ne(subscriptions.status, 'ended'),
          ),
        )
        .returning({ planKey: subscriptions.planKey })
      if (row === undefined) return null
      const after = (await loadStanding(tx, userId, now)).plan
      await writeEntries(tx, userId, 'system:billing', source, [
        { action: REVOKED, data: { provider: billing.provider, subscription: sub, plan: row.planKey, why } },
        ...subscriptionChanges(before.subs, await snapshotSubscriptions(tx, userId)),
        ...planChange(before.plan, after),
      ])
      if (after !== before.plan) await this.#jobs.enqueueEligibility(await listingsOfOwner(tx, userId), tx)
      return row.planKey
    })
    if (planKey === null) return false
    const to = await emailOf(this.#db, userId)
    if (to !== null)
      await this.#mailer.send({ to, ...planEnded({ plan: planName(planKey), why, origin: this.#webOrigin }) })
    await this.#accounts.enforceLimits(userId)
    return true
  }
}

/** Why Blockly ended the subscription itself, from the audit log; null when it didn't. */
export async function endedFor(
  q: Queryable,
  sub: Pick<SubscriptionRecord, 'userId' | 'status' | 'externalSubscriptionId'>,
): Promise<EndedFor | null> {
  if (sub.status !== 'ended') return null
  const [row] = await q
    .select({ why: sql<string>`${schema.auditLog.data}->>'why'` })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.subjectType, 'account'),
        eq(schema.auditLog.subjectId, sub.userId),
        eq(schema.auditLog.action, REVOKED),
        sql`${schema.auditLog.data}->>'subscription' = ${sub.externalSubscriptionId}`,
      ),
    )
    .orderBy(desc(schema.auditLog.at))
    .limit(1)
  return row?.why === 'withdrawal' || row?.why === 'unpaid' ? row.why : null
}
