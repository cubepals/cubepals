// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moving between paid plans. Plus bought over Core leaves Core's subscription renewing at the
 * provider, to run out with the month paid for. Plus down to Core is a move the provider applies
 * when the month paid for ends: Plus stays until then, and nothing is paid twice. Core is never
 * bought over Plus. Not for what a smaller plan runs (`entitlements.ts`).
 */
import { type Db, type Queryable, schema } from '@blockly/db'
import { PAID_PLANS, planName } from '../../domain/account/entitlements.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { AppError } from '../errors.ts'
import type { BillingProvider } from '../ports/optional.ts'
import { latestSubscription, otherRenewing, PAYING, recordMove } from './persistence.ts'

/** Refuses a smaller plan over a larger one: it is a move at the month's end, never a second payment. */
export function requireNotSmaller(current: string, wanted: string): void {
  if (current === 'free' || PAID_PLANS.indexOf(current) <= PAID_PLANS.indexOf(wanted)) return
  throw new AppError(
    'invalid_choice',
    `You have ${planName(current)} now. Move to ${planName(wanted)} from your account: it starts when the month you paid for ends, and ${planName(current)} stays until then.`,
  )
}

/**
 * The paying subscription moves to a smaller plan when the period paid for ends. The provider
 * applies it then; the plan in force stays until it does, and its servers are judged by the new
 * plan only from that day. Audited with what it moves from and to.
 */
export async function moveToSmaller(
  db: Db,
  billing: BillingProvider,
  userId: string,
  wanted: string,
  actor: Actor,
  reach: <T>(call: () => Promise<T>) => Promise<T>,
): Promise<{ plan: string; at: Date }> {
  const sub = await latestSubscription(db, userId)
  if (sub === null || sub.provider !== billing.provider || !PAYING.includes(sub.status))
    throw new AppError('invalid_choice', 'You have no plan paid by the month to move.')
  if (!PAID_PLANS.includes(wanted) || PAID_PLANS.indexOf(wanted) >= PAID_PLANS.indexOf(sub.planKey))
    throw new AppError('invalid_choice', `${planName(wanted)} isn’t smaller than ${planName(sub.planKey)}.`)
  if (!billing.sells(wanted)) throw new AppError('invalid_choice', `${planName(wanted)} isn’t available yet.`)
  if (sub.cancelAtPeriodEnd)
    throw new AppError('invalid_choice', `${planName(sub.planKey)} already ends with this month.`)
  const { appliesAt } = await reach(() => billing.moveToPlan(sub.externalSubscriptionId, wanted))
  await recordMove(db, billing.provider, sub.externalSubscriptionId, wanted, appliesAt)
  await db.insert(schema.auditLog).values({
    actor: requestedBy(actor),
    action: 'billing.plan_move_scheduled',
    subjectType: 'account',
    subjectId: userId,
    data: { from: sub.planKey, to: wanted, at: appliesAt.toISOString() },
  })
  return { plan: wanted, at: appliesAt }
}

/** The account's subscriptions still renewing for a plan smaller than the one now paying (`paying`). */
export async function smallerRenewing(
  q: Queryable,
  userId: string,
  provider: string,
  paying: { externalSubscriptionId: string; planKey: string },
): Promise<string[]> {
  const rank = PAID_PLANS.indexOf(paying.planKey)
  const others = await otherRenewing(q, userId, provider, paying.externalSubscriptionId)
  return others.filter((other) => PAID_PLANS.indexOf(other.planKey) < rank).map((other) => other.id)
}
