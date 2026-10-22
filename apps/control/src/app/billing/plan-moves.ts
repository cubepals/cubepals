// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moving between paid plans. Core up to Plus changes the product of the one subscription that
 * pays for it, now, so there is never a second subscription to renew beside it. Plus down to Core
 * is a move the provider applies when the month paid for ends: Plus stays until then, and nothing
 * is paid twice. Core is never bought over Plus. Not for what a smaller plan runs (`entitlements.ts`).
 */
import { type Db, type Queryable, schema } from '@blockly/db'
import { PAID_PLANS, planName } from '../../domain/account/entitlements.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { AppError } from '../errors.ts'
import type { BillingProvider } from '../ports/optional.ts'
import { latestSubscription, otherRenewing, PAYING, recordMove } from './persistence.ts'

/**
 * Refuses a smaller plan over a larger one. Where a monthly subscription pays for the larger, it is
 * a move at the month's end from the account; where none does (a year, a gift, an admin's), there
 * is nothing to move, and the smaller plan opens when the larger ends.
 */
export async function requireNotSmaller(
  db: Db,
  userId: string,
  current: string,
  wanted: string,
): Promise<void> {
  if (current === 'free' || PAID_PLANS.indexOf(current) <= PAID_PLANS.indexOf(wanted)) return
  const sub = await latestSubscription(db, userId)
  const movable =
    sub !== null && PAYING.includes(sub.status) && !sub.cancelAtPeriodEnd && sub.planKey === current
  throw new AppError(
    'invalid_choice',
    movable
      ? `You have ${planName(current)} now. Move to ${planName(wanted)} from your account: it starts when the month you paid for ends, and ${planName(current)} stays until then.`
      : `You have ${planName(current)} until it ends, and ${planName(wanted)} opens when it does.`,
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

/**
 * A larger plan bought by an account whose monthly subscription pays for a smaller one: the
 * subscription becomes the larger plan's, the provider charging the difference for the rest of the
 * month, and a refusal from the provider is the caller's to fail. False where no monthly
 * subscription pays for a smaller plan, and the larger is bought at a checkout.
 */
export async function upgradeInPlace(
  db: Db,
  billing: BillingProvider,
  userId: string,
  wanted: string,
  actor: Actor,
  reach: <T>(call: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
  const sub = await latestSubscription(db, userId)
  if (sub === null || sub.provider !== billing.provider || !PAYING.includes(sub.status)) return false
  if (PAID_PLANS.indexOf(sub.planKey) >= PAID_PLANS.indexOf(wanted)) return false
  await reach(() => billing.upgradeSubscription(sub.externalSubscriptionId, wanted))
  await db.insert(schema.auditLog).values({
    actor: requestedBy(actor),
    action: 'billing.plan_upgraded_in_place',
    subjectType: 'account',
    subjectId: userId,
    data: { from: sub.planKey, to: wanted },
  })
  return true
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
