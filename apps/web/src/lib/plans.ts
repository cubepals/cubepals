// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plan and size tables as the public pages read them, and the few ways their numbers are said
 * in words. Not for the account's own plan, which the signed-in pages read through the API.
 */
import type { PublicPlan, PublicSize } from '@blockly/contracts'
import { apiUpstream, RENDER_READ_MS } from './upstream'

/**
 * The plans, read server-side from the control plane's public endpoint: the same table it
 * enforces. Empty when it can't be reached, so a page shows its words without the cards rather
 * than failing. Read afresh each time, unless a page says how many seconds a reading may be kept:
 * the landing page does, since it is the page most people load and the table seldom changes.
 * A control plane that doesn't answer within RENDER_READ_MS counts as unreachable: neither a page
 * nor a build that renders these pages waits on a stopped one.
 */
export async function publicPlans(keptSeconds?: number): Promise<PublicPlan[]> {
  try {
    const response = await fetch(`${apiUpstream()}/api/public/plans`, {
      signal: AbortSignal.timeout(RENDER_READ_MS),
      ...(keptSeconds === undefined ? { cache: 'no-store' } : { next: { revalidate: keptSeconds } }),
    })
    return response.ok ? ((await response.json()) as PublicPlan[]) : []
  } catch {
    return []
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
    return response.ok ? ((await response.json()) as PublicSize[]) : []
  } catch {
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
 * A plan's hours of play as people say them: "20 hours in all, at most 2 a day", "120 hours a
 * month", "2 hours every day".
 */
export const hoursSaid = (plan: Pick<PublicPlan, 'includedHours' | 'per' | 'totalHours'>): string => {
  if (plan.totalHours !== null) return `${plan.totalHours} hours in all, at most ${plan.includedHours} a day`
  return `${plan.includedHours} hours ${plan.per === 'day' ? 'every day' : 'a month'}`
}

/**
 * When the plans' hours start again, as a sentence about running out says it: "the hours start
 * again: Free’s at midnight where you are, until its 20 are played; Plus’s on the 1st".
 */
export function hoursAgainSaid(plans: readonly PublicPlan[]): string {
  const each = plans.map((plan) => {
    const when = plan.per === 'day' ? 'at midnight where you are' : 'on the 1st'
    return `${plan.name}’s ${when}${plan.totalHours === null ? '' : `, until its ${plan.totalHours} are played`}`
  })
  return each.length > 0 ? `the hours start again: ${each.join('; ')}` : 'the hours start again'
}
