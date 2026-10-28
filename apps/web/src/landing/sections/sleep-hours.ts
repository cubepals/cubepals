// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What the sleep demonstration's week of play comes to against a plan's hours, in the words under
 * its tally: inside them, or past them and what happens then. The week's arithmetic is
 * SleepDemo.tsx's; the plan's hours, a month's or the free trial's in all, are the pricing page's.
 */
import type { PublicPlan } from '@blockly/contracts'

/**
 * A plan whose largest server holds this many players can run a large one, and a large server
 * counts two of the plan's hours for each hour it runs, the largest four, past LARGEST_FROM_PLAYERS
 * (apps/control/src/domain/server/size.ts,
 * apps/control/src/domain/account/meter.ts). The words for it are the pricing page's
 * (apps/web/src/app/(public)/pricing/page.tsx).
 */
const LARGE_FROM_PLAYERS = 20
const LARGEST_FROM_PLAYERS = 50

/** What a week comes to against the plan's own hours (`usedBy`, SleepDemo.tsx), in words. */
export function usedSaid(used: number, plan: PublicPlan, plans: readonly PublicPlan[]): string {
  const included = plan.includedHours
  const once = plan.per === 'once'
  const hours = `${included} hours${once ? ' in all' : ''} on ${plan.name}`
  if (used === 0) return `Nothing ran, so none of the ${hours} were used.`
  if (used > included) {
    // A plan that would hold it, said the way the account page says it: past the trial's hours,
    // the paid one; past a month's, a bigger month. Only a paid plan allows extra hours
    // (mayBuyMore, entitlements.ts), as the pricing page says.
    const roomier = plans.find((each) =>
      once ? each.monthlyPriceCents > 0 : each.includedHours > included && each.includedHours >= used,
    )
    const extra = plan.monthlyPriceCents > 0 ? ', unless you allow extra hours, up to a limit you set' : ''
    const then = once
      ? 'When they’re played, the trial ends and the server sleeps until a paid plan starts it again'
      : `When they run out, the server sleeps until the 1st, when the hours start again${extra}`
    return `More than the ${hours}. ${then}.${roomier ? ` ${roomier.name} has ${roomier.includedHours} hours a month.` : ''}`
  }
  // The week counts an hour awake as one of the plan's hours. On a plan that runs large servers
  // that isn't the whole of it, and the note says so.
  const large = plan.maxPlayers >= LARGE_FROM_PLAYERS
  return `Inside the ${hours}${once ? `, with ${included - used} left after a week like this` : ''}.${
    large
      ? ` A large server, for big modpacks and groups of ${LARGE_FROM_PLAYERS} or more, counts two hours for each hour it runs${plan.maxPlayers > LARGEST_FROM_PLAYERS ? `, and the largest, for groups of more than ${LARGEST_FROM_PLAYERS}, four` : ''}.`
      : ''
  }`
}
