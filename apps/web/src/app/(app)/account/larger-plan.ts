// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The plan with more hours than the person's own, for an upgrade, as the account page states it:
 * which plan it is comes from the plan table, and its price and hours a month are what a new
 * subscriber is offered now (`offeredMonth`), the same the cards and the pricing page say. Not the
 * person's own plan, which the page states as their subscription holds it.
 */
import { type AccountOverviewView, extraHoursCheaper, type PublicPlan } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '../../../lib/api'
import { offeredMonth } from '../offered-month'

export interface LargerPlan {
  key: string
  priceCents: number
  hours: number | null
}

/** The larger plan, from the overview's plans and `listed` (`billing.plans`); none on the largest. */
function largerPlan(
  overview: AccountOverviewView,
  listed: readonly PublicPlan[] | undefined,
): LargerPlan | undefined {
  const more = overview.plans.find(
    (p) =>
      (p.entitlements.includedUnits ?? 0) > (overview.entitlements.includedUnits ?? 0) &&
      p.entitlements.monthlyPriceCents > overview.entitlements.monthlyPriceCents,
  )
  if (more === undefined) return undefined
  return {
    key: more.key,
    ...offeredMonth(
      more.entitlements,
      listed?.find((p) => p.key === more.key),
    ),
  }
}

/** `largerPlan`, with the plans as `billing.plans` answers them. */
export function useLargerPlan(overview: AccountOverviewView): LargerPlan | undefined {
  const trpc = useTRPC()
  const listed = useQuery(trpc.billing.plans.queryOptions())
  return largerPlan(overview, listed.data)
}

/**
 * Past how many extra hours a month the larger plan costs less than the person's own and those
 * hours: its offered month over what their subscription pays. Null where it costs no more.
 */
export const pastWhichCheaper = (overview: AccountOverviewView, more: LargerPlan): number | null =>
  extraHoursCheaper(more.priceCents, overview.entitlements.monthlyPriceCents, overview.usage.unitCents)
