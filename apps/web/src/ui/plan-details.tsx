// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a plan card on the public pages says: a paid plan's few lines of what you get on its face,
 * and everything else in its details, opened in place. The free trial has no card of its own: it
 * is how the first paid plan starts. Not for the account page, whose cards list a plan's points.
 */
import type { PublicPlan } from '@blockly/contracts'
import type { ReactNode } from 'react'
import { dollars, eachOf, forSale, hoursPoint, keptPoint, PlanPoint, priceOf } from './plans'

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

/** The line over the button that starts the trial, in its two parts: "20 hours free", ", no card". */
export const freeSaid = (trial: Pick<PublicPlan, 'totalHours'>): [string, string] => [
  trial.totalHours ? `${trial.totalHours} hours free` : 'Free to start',
  ', no card',
]

/**
 * A paid plan's message as the multiplayer list would show it, in two lines: what it plays, and
 * who joins or what it adds. Java and Bedrock together is said only where Bedrock is on.
 */
export function serverMessage(
  plan: PublicPlan,
  plans: readonly PublicPlan[],
  bedrock: boolean,
): [string, string?] {
  const before = cardsOf(plans).cards.find((other) => other !== plan && !other.mods)
  if (plan.mods) return ['Mods and modpacks', before ? `Everything in ${before.name}, and more` : undefined]
  return ['Plain Minecraft', bedrock ? 'Java and Bedrock, one address' : undefined]
}

/** A paid card's first line: who it is for, or what it adds to the plan before it. */
export function offerPitch(plan: PublicPlan, plans: readonly PublicPlan[]): string {
  const before = cardsOf(plans).cards.find((other) => other !== plan && !other.mods)
  if (plan.mods) return before ? `Everything in ${before.name}, and mods` : 'Mods, plugins and modpacks'
  return 'Plain Minecraft with your friends'
}

/** What a line on a card is about, which picks its picture. */
export type PointKind = 'friends' | 'bridge' | 'moon' | 'chest' | 'crowd' | 'anvil' | 'servers'

/**
 * What you get on a plan, in a few short lines, with no hours: those are in its details, with the
 * sessions it keeps.
 */
export function offerPoints(plan: PublicPlan, bedrock: boolean): { said: string; kind: PointKind }[] {
  if (plan.mods)
    return [
      { said: `Up to ${plan.maxPlayers} players`, kind: 'crowd' },
      {
        said: plan.datapacks ? 'Mods, plugins, modpacks and datapacks' : 'Mods, plugins and modpacks',
        kind: 'anvil',
      },
      { said: plan.maxServers === 1 ? '1 server' : `Up to ${plan.maxServers} servers`, kind: 'servers' },
    ]
  return [
    { said: plan.maxPlayers > 1 ? `You and ${plan.maxPlayers - 1} friends` : 'Just you', kind: 'friends' },
    ...(bedrock ? [{ said: 'Java and Bedrock friends on one server', kind: 'bridge' as const }] : []),
    { said: 'Sleeps when nobody’s on, wakes when someone joins', kind: 'moon' },
    { said: 'Backups, and your world to download', kind: 'chest' },
  ]
}

/** What bigger groups run on, said in the details of the plan that has them. */
const LARGE_SERVERS =
  'Big modpacks and groups of 20 or more run on a large server, which counts two hours for each hour it runs. Groups of more than 50 run on the largest, which counts four.'

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
            Starts with a free trial: <PlanPoint plan={trial} point={hoursPoint(trial)} />, no card
          </li>
        )}
        <li>Hours count only while your server is awake, not for each player</li>
        <li>{keptPoint(plan)}</li>
        <li>{plan.mods ? LARGE_SERVERS : 'Plain Minecraft: vanilla or Paper'}</li>
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
