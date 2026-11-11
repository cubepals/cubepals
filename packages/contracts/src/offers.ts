// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a month of a paid plan charges a new subscriber now, and the plans with it in place of the
 * plan table's: the one reading every public page states a price from. Not how an offer is
 * decided, which is the control plane's.
 */
import type { PublicPlan } from './accounts.ts'

/**
 * What a month of a paid plan charges someone who subscribes now, for anyone to read: its price
 * and hours, the plan's own or an early price's while one is open. Never how much room is left
 * or how many took it. Everything public that states a plan's price or hours states these
 * (`withOffers`), falling back to the plan table's own, all together, where they can't be read.
 */
export interface PublicOffer {
  plan: string
  priceCents: number
  /** Null where the price's product doesn't say: the plan's own hours stand. */
  includedHours: number | null
}

/**
 * Whether a year at `yearlyCents` is sold beside a month at `monthlyCents`: only while it costs no
 * more than twelve of those months. The control plane refuses a year's checkout where it isn't.
 */
export const yearSold = (yearlyCents: number, monthlyCents: number): boolean =>
  yearlyCents <= 12 * monthlyCents

/**
 * The plans with each offer's price and hours in place of the plan table's, for everything that
 * states them, and without a year where twelve months at the offered price cost less.
 */
export function withOffers(plans: readonly PublicPlan[], offers: readonly PublicOffer[]): PublicPlan[] {
  return plans.map((plan) => {
    if (plan.per !== 'month' || plan.monthlyPriceCents === 0) return plan
    const offer = offers.find((each) => each.plan === plan.key)
    const monthlyPriceCents = offer?.priceCents ?? plan.monthlyPriceCents
    const year = plan.yearlyPriceCents
    const yearlyPriceCents = year !== null && yearSold(year, monthlyPriceCents) ? year : null
    if (offer === undefined && yearlyPriceCents === year) return plan
    return {
      ...plan,
      monthlyPriceCents,
      yearlyPriceCents,
      includedHours: offer?.includedHours ?? plan.includedHours,
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
