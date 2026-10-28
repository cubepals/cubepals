// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PublicPlan } from './accounts.ts'

/**
 * What a month of a paid plan charges someone who subscribes now, for anyone to read: its price
 * and hours, the plan's own or an early price's while one is open. Never how much room is left
 * or how many took it. The plan table's own figures stay in `PublicPlan`, for what is cached or
 * sent (structured data, emails), which can't know whether one is open.
 */
export interface PublicOffer {
  plan: string
  priceCents: number
  /** Null where the price's product doesn't say: the plan's own hours stand. */
  includedHours: number | null
}

/** The plans with each offer's price and hours in place of the plan table's, for the cards people choose on. */
export function withOffers(plans: readonly PublicPlan[], offers: readonly PublicOffer[]): PublicPlan[] {
  return plans.map((plan) => {
    const offer = offers.find((each) => each.plan === plan.key)
    return offer === undefined || plan.per !== 'month' || plan.monthlyPriceCents === 0
      ? plan
      : {
          ...plan,
          monthlyPriceCents: offer.priceCents,
          includedHours: offer.includedHours ?? plan.includedHours,
        }
  })
}

/**
 * A paid plan's card as its own subscriber holds it: the price and hours their subscription pays
 * for (their entitlements), which stay whatever a new subscriber is offered. Any other plan, or
 * the trial, as it is.
 */
export function asHeld(
  plan: PublicPlan,
  held: { plan: string; monthlyPriceCents: number; includedUnits: number | null },
): PublicPlan {
  if (plan.key !== held.plan || plan.monthlyPriceCents === 0) return plan
  return {
    ...plan,
    monthlyPriceCents: held.monthlyPriceCents,
    includedHours: held.includedUnits ?? plan.includedHours,
  }
}
