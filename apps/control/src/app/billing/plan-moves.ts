// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moving between paid plans. Plus bought over Core leaves Core's subscription renewing at the
 * provider, to run out with the month paid for; Core bought over Plus is refused until Plus is
 * ended, so nothing is ever paid twice. Not for what a smaller plan runs (`entitlements.ts`).
 */
import type { Queryable } from '@blockly/db'
import { PAID_PLANS, planName } from '../../domain/account/entitlements.ts'
import { AppError } from '../errors.ts'
import { otherRenewing } from './persistence.ts'

/** Refuses a smaller plan over a larger one: the larger is ended first, in Manage billing, which is the player's to decide. */
export function requireNotSmaller(current: string, wanted: string): void {
  if (current === 'free' || PAID_PLANS.indexOf(current) <= PAID_PLANS.indexOf(wanted)) return
  throw new AppError(
    'invalid_choice',
    `You have ${planName(current)} now. To move to ${planName(wanted)}, end ${planName(current)} in Manage billing first. Your servers and worlds stay as they are.`,
  )
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
