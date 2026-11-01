// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The way on for an owner whose free trial is used up: the plan that plays by the month and is on
 * sale here, read from the plans the control plane lists, never typed out, and the checkout for
 * it, which comes back to their server. Not for the trial's own words (`app/(public)/resting.tsx`).
 */
import type { PublicPlan } from '@blockly/contracts'
import { forSale } from '../ui/plans'
import { checkoutHref } from './checkout'

/** The plan with hours every month that is for sale here; null where none is. */
export const monthlyOnSale = (plans: readonly PublicPlan[]): PublicPlan | null =>
  plans.find(
    (plan) => plan.per === 'month' && plan.totalHours === null && plan.monthlyPriceCents > 0 && forSale(plan),
  ) ?? null

/** Checkout for `plan`, by the month, counted as reached for at the trial's end, back to the server after. */
export const keepPlayingHref = (plan: string, serverId: string): string =>
  checkoutHref({ plan, reason: 'trial_over', next: `/servers/${serverId}` })
