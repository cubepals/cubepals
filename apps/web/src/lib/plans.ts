import type { PublicPlan, PublicSize } from '@blockly/contracts'
import { apiUpstream } from './upstream'

/**
 * The plans, read server-side from the control plane's public endpoint: the same table it
 * enforces. Empty when it can't be reached, so a page shows its words without the cards rather
 * than failing. Read afresh each time, unless a page says how many seconds a reading may be kept:
 * the landing page does, since it is the page most people load and the table seldom changes.
 */
export async function publicPlans(keptSeconds?: number): Promise<PublicPlan[]> {
  try {
    const response = await fetch(
      `${apiUpstream()}/api/public/plans`,
      keptSeconds === undefined ? { cache: 'no-store' } : { next: { revalidate: keptSeconds } },
    )
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
    const response = await fetch(`${apiUpstream()}/api/public/sizes`, { next: { revalidate: keptSeconds } })
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
