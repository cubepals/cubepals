// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a plan card on the public pages says: a paid plan's few lines of what you get on its face,
 * and everything else in its details, opened in place. The free trial has no card of its own, here
 * or on the account page: it is how the first paid plan starts (`cardsOf`). Not for the account
 * page's cards, which list a plan's points.
 */
import type { PublicPlan } from '@blockly/contracts'
import type { ReactNode } from 'react'
import {
  dollars,
  eachOf,
  forSale,
  gbSaid,
  hoursPoint,
  keptPoint,
  PlanPoint,
  priceOf,
  sizesOf,
  TrialPoint,
} from './plans'

/** The trial, the paid plans that get a card each, and the one the trial starts. */
export function cardsOf(plans: readonly PublicPlan[]) {
  const free = plans.find((plan) => plan.monthlyPriceCents === 0)
  const cards = plans.filter((plan) => plan.monthlyPriceCents > 0)
  return { trial: free && forSale(free) ? free : undefined, cards, starter: cards[0] }
}

/** The plans in one line: "Core starts free, and Plus adds mods". */
export function plansSaid(plans: readonly PublicPlan[]): string {
  const { trial, starter } = cardsOf(plans)
  if (!starter) return 'Start free'
  const first = trial
    ? `${starter.name} starts free`
    : `${starter.name} is ${priceOf(starter.monthlyPriceCents)}`
  const plus = plans.find((plan) => plan.mods && plan !== starter)
  return plus ? `${first}, and ${plus.name} adds mods` : first
}

/** What the trial gives, said as the price of the plan it starts: "20 hours free". */
export const freeSaid = (trial: Pick<PublicPlan, 'totalHours'>): string =>
  trial.totalHours ? `${trial.totalHours} hours free` : 'Free to start'

/** A card's line under its name: what it plays, or that it has all of the plan before it. */
export function offerPitch(plan: PublicPlan, plans: readonly PublicPlan[]): string {
  const before = cardsOf(plans).cards.find((other) => other !== plan && !other.mods)
  if (plan.mods) return before ? `Everything in ${before.name}, and more` : 'Mods and modpacks'
  return 'Plain Minecraft'
}

/** What a line on a card is about, which picks its picture. */
export type PointKind = 'friends' | 'bridge' | 'moon' | 'chest' | 'crowd' | 'anvil' | 'servers'

/**
 * What you get on a plan, in three short lines, with no hours: those are in its details, with the
 * servers, the sessions it keeps and the rest.
 */
export function offerPoints(plan: PublicPlan, bedrock: boolean): { said: string; kind: PointKind }[] {
  if (plan.mods)
    return [
      { said: `Up to ${plan.maxPlayers} players`, kind: 'crowd' },
      { said: 'Mods and modpacks', kind: 'anvil' },
      { said: plan.maxServers === 1 ? '1 server' : `Up to ${plan.maxServers} servers`, kind: 'servers' },
    ]
  return [
    { said: plan.maxPlayers > 1 ? `You and ${plan.maxPlayers - 1} friends` : 'Just you', kind: 'friends' },
    bedrock
      ? { said: 'Java and Bedrock together', kind: 'bridge' }
      : { said: 'Backups, and your world to download', kind: 'chest' },
    { said: 'Sleeps when nobody’s on', kind: 'moon' },
  ]
}

const TIMES: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four' }

/**
 * How big a plan's servers are, from its sizes, so "is it unlimited?" has its answer: one size and
 * the players it holds, or every size, with the ones that count more than an hour for each hour
 * they run. Null where the answer predates the sizes.
 */
function sizePoint(plan: PublicPlan, trial?: PublicPlan): string | null {
  const sizes = sizesOf(plan)
  const [only] = sizes
  if (only === undefined) return null
  if (sizes.length === 1) {
    const same = trial !== undefined && gbSaid(trial) === gbSaid(plan)
    return `A ${only.gb} GB server, for up to ${only.maxPlayers} players${same ? ', on the free trial too' : ''}`
  }
  const gbs = sizes.map((size) => size.gb)
  const listed = `${gbs.slice(0, -1).join(', ')} or ${gbs.at(-1)} GB`
  const counted = sizes
    .filter((size) => size.hoursAnHour > 1)
    .map((size, i) =>
      i === 0
        ? `${size.gb} GB holds up to ${size.maxPlayers} players and counts ${TIMES[size.hoursAnHour] ?? size.hoursAnHour} hours for each hour it runs`
        : `${size.gb} GB holds up to ${size.maxPlayers} and counts ${TIMES[size.hoursAnHour] ?? size.hoursAnHour}`,
    )
  return `Servers of ${listed}, sized for your group and game${counted.length > 0 ? `. ${counted.join('; ')}` : ''}`
}

/**
 * "See everything in Core": the rest of a plan, opened in place. The hours sit on their dashed
 * line, which says what they come to; the trial's, on the plan it starts.
 */
export function PlanDetails({
  plan,
  trial,
  year,
  marker,
  className = '',
}: {
  plan: PublicPlan
  /** The free trial, on the plan it starts. */
  trial?: PublicPlan | undefined
  /** The year's line as a link to buy it, where the page has one; otherwise it is said. False: the card says it elsewhere. */
  year?: ReactNode | false
  /** What turns as the details open, after the summary's words. */
  marker: ReactNode
  className?: string
}) {
  const shared = eachOf(plan)
  return (
    <details className={`bk-plan-more ${className}`}>
      <summary>
        See everything in {plan.name}
        {marker}
      </summary>
      <ul className="bk-plan-more__list">
        <li>
          <PlanPoint plan={plan} point={hoursPoint(plan)} />
        </li>
        {trial && (
          <li>
            <TrialPoint trial={trial} />
          </li>
        )}
        {sizePoint(plan, trial) && <li>{sizePoint(plan, trial)}</li>}
        <li>Hours count only while your server is awake, not for each player</li>
        <li>{keptPoint(plan)}</li>
        {!plan.mods && <li>Plain Minecraft: vanilla or Paper</li>}
        {plan.mods && <li>{plan.datapacks ? 'Plugins and datapacks work too' : 'Plugins work too'}</li>}
        {plan.yearlyPriceCents && year !== false ? (
          <li>{year ?? `Or ${dollars(plan.yearlyPriceCents)} for a year, paid once`}</li>
        ) : null}
        {shared && (
          <li>
            {shared.each} each, shared by {shared.friends} friends
          </li>
        )}
      </ul>
    </details>
  )
}
