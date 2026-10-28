// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plan and size tables as the public pages read them, and the few ways their numbers are said
 * in words. Not for the account's own plan, which the signed-in pages read through the API.
 */
import { type PublicOffer, type PublicPlan, type PublicSize, withOffers } from '@blockly/contracts'
import { planSaid } from '../ui/plans'
import { markPartial } from './partial-render'
import { apiUpstream, RENDER_READ_MS } from './upstream'

/**
 * The plans, read server-side from the control plane's public endpoint: the same table it
 * enforces. Empty when it can't be reached, so a page shows its words without the cards rather
 * than failing. Read afresh each time, unless a page says how many seconds a reading may be kept:
 * the landing page does, since it is the page most people load and the table seldom changes.
 * A control plane that doesn't answer within RENDER_READ_MS counts as unreachable: neither a page
 * nor a build that renders these pages waits on a stopped one. A page made from an empty answer
 * isn't kept at the edge (lib/partial-render.ts).
 */
export async function publicPlans(keptSeconds?: number): Promise<PublicPlan[]> {
  try {
    const response = await fetch(`${apiUpstream()}/api/public/plans`, {
      signal: AbortSignal.timeout(RENDER_READ_MS),
      ...(keptSeconds === undefined ? { cache: 'no-store' } : { next: { revalidate: keptSeconds } }),
    })
    const plans = response.ok ? ((await response.json()) as PublicPlan[]) : []
    if (plans.length === 0) markPartial()
    return plans
  } catch {
    markPartial()
    return []
  }
}

/** How long what a month charges now may be kept: the control plane keeps it as long. */
const OFFER_KEPT_SECONDS = 60

/**
 * The plans with what a month of each charges someone who subscribes now (`/api/public/offer`), for
 * the cards and words people choose on: the plan's own price and hours, or an early price's while
 * one is open, kept a minute. Where it can't be read, the plan table's own. Never for what is
 * cached longer or sent (structured data, the title), which keeps `plans` as they are.
 */
export async function offeredPlans(plans: readonly PublicPlan[]): Promise<PublicPlan[]> {
  try {
    const response = await fetch(`${apiUpstream()}/api/public/offer`, {
      signal: AbortSignal.timeout(RENDER_READ_MS),
      next: { revalidate: OFFER_KEPT_SECONDS },
    })
    return withOffers(plans, response.ok ? ((await response.json()) as PublicOffer[]) : [])
  } catch {
    return [...plans]
  }
}

/**
 * The size behind each answer to "Who's playing", from the table servers are made with. Empty when
 * it can't be reached, like the plans; kept as long as a page says.
 */
export async function publicSizes(keptSeconds: number): Promise<PublicSize[]> {
  try {
    const response = await fetch(`${apiUpstream()}/api/public/sizes`, {
      signal: AbortSignal.timeout(RENDER_READ_MS),
      next: { revalidate: keptSeconds },
    })
    const sizes = response.ok ? ((await response.json()) as PublicSize[]) : []
    if (sizes.length === 0) markPartial()
    return sizes
  } catch {
    markPartial()
    return []
  }
}

/** A number of days as people say it: "two weeks", "a month", "a year". */
export function daysSaid(days: number): string {
  if (days === 365) return 'a year'
  if (days === 30) return 'a month'
  if (days === 14) return 'two weeks'
  if (days % 7 === 0) return `${days / 7} weeks`
  return `${days} days`
}

/**
 * A plan's hours of play as people say them: "20 hours in all, any day you like", "120 hours a
 * month".
 */
export const hoursSaid = (plan: Pick<PublicPlan, 'includedHours' | 'totalHours'>): string =>
  plan.totalHours !== null
    ? `${plan.totalHours} hours in all, any day you like`
    : `${plan.includedHours} hours a month`

/**
 * When the plans' hours start again, as a sentence about running out says it: "the hours start
 * again: Core’s and Plus’s on the 1st". Hours that come once, the free trial's, never start again,
 * so they are left out; what their end means is said apart.
 */
export function hoursAgainSaid(plans: readonly PublicPlan[]): string {
  const monthly = plans.filter((plan) => plan.totalHours === null)
  const names = monthly.map((plan) => `${planSaid(plan)}’s`)
  return names.length > 0
    ? `the hours start again: ${names.join(' and ')} on the 1st`
    : 'the hours start again'
}
