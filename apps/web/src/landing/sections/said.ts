// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/** What the landing says about the plans in a few words, from the plan table itself. */
import type { PublicPlan } from '@blockly/contracts'
import { eachOf, priceOf } from '../../ui/plans'

/** The free trial in a few words, from its own hours: "20 hours free, no card." */
export function trialSaid(plans: readonly PublicPlan[]): string {
  const free = plans.find((plan) => plan.monthlyPriceCents === 0)
  return free?.totalHours ? `${free.totalHours} hours free, no card` : 'Start with a free trial, no card'
}

/** The trial, and what the paid plan comes to for a group: the line under the last button. */
export function lastSaid(plans: readonly PublicPlan[]): string {
  const paid = plans.find((plan) => plan.monthlyPriceCents > 0)
  const shared = paid ? eachOf(paid) : null
  if (!paid || !shared) return `${trialSaid(plans)}.`
  return `${trialSaid(plans)}. ${paid.name} is ${priceOf(paid.monthlyPriceCents)}, ${shared.each} each for ${shared.friends} friends.`
}
