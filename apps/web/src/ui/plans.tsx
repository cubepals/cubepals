// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PublicPlan } from '@blockly/contracts'
import type { ReactNode } from 'react'
import { SOURCE_URL } from './brand'
import { OutLink } from './out-link'
import { Tip } from './tip'

/**
 * Who a plan is for and what they play on it, as the person choosing would put it: the first thing
 * a card says, and never its hours. Core says Java and Bedrock friends play together only where
 * Bedrock is on (`lib/bedrock.ts`), and promises nothing about Bedrock where it is off.
 */
/**
 * Whether a plan is on sale: only the API saying so (`available: false`) takes it off. A plans
 * answer from before the field existed, while the site and the API deploy minutes apart, shows
 * every plan as it always did.
 */
export const forSale = (plan: Pick<PublicPlan, 'available'>): boolean =>
  (plan.available as boolean | undefined) !== false

/** The sizes a plan's servers run at, smallest first; none where the answer predates them. */
export const sizesOf = (plan: Pick<PublicPlan, 'sizes'>): PublicPlan['sizes'] =>
  Array.isArray(plan.sizes) ? plan.sizes : []

/** A plan's sizes in a few words: "3 GB", "3 to 16 GB". Empty where the answer predates them. */
export function gbSaid(plan: Pick<PublicPlan, 'sizes'>): string {
  const sizes = sizesOf(plan)
  const [first, last] = [sizes[0], sizes.at(-1)]
  if (first === undefined || last === undefined) return ''
  return first === last ? `${first.gb} GB` : `${first.gb} to ${last.gb} GB`
}

/** What an extra hour costs on a plan, in cents; null where the plan has none or the answer predates it. */
export const extraHourOf = (plan: Pick<PublicPlan, 'extraHourCents'>): number | null =>
  typeof plan.extraHourCents === 'number' ? plan.extraHourCents : null

export function pitchOf(plan: Pick<PublicPlan, 'key' | 'maxPlayers'>, bedrock = false): string {
  switch (plan.key) {
    case 'core':
      return `Plain Minecraft for you and ${plan.maxPlayers - 1} friends${bedrock ? ', Java and Bedrock together' : ''}`
    case 'plus':
      return 'Mods, plugins and modpacks, for bigger groups'
    default:
      return ''
  }
}

/**
 * A plan in the four things people choose on, in their words: no units or minutes, and its servers'
 * memory only as their size, so nobody wonders whether it is unlimited.
 * The free trial says what it is rather than what it lacks, so nothing on it is crossed out. Starting when
 * someone joins is every plan's and the page's headline, so no card repeats it.
 */
export function planPoints(plan: PublicPlan): string[] {
  const gb = gbSaid(plan)
  return [
    plan.maxServers === 1
      ? `1 server${gb ? ` of ${gb}` : ''}, up to ${plan.maxPlayers} players`
      : `Up to ${plan.maxServers} servers and ${plan.maxPlayers} players${gb ? `, ${gb} each` : ''}`,
    hoursPoint(plan),
    addOns(plan),
    keptPoint(plan),
  ]
}

/** The sessions a plan keeps to go back to, and how its world is downloaded. */
export const keptPoint = (plan: Pick<PublicPlan, 'downloads' | 'sessionsKept'>): string =>
  plan.downloads === 'history'
    ? `Go back to any of your last ${plan.sessionsKept} sessions, and a weekly download`
    : `Go back to any of your last ${plan.sessionsKept} sessions, and download your world`

/**
 * A plan's name inside a sentence: "Plus", or "the free trial" for the one whose hours come once,
 * which is a trial and not a plan that lasts.
 */
export const planSaid = (plan: Pick<PublicPlan, 'name' | 'totalHours'>): string =>
  plan.totalHours === null ? plan.name : `the ${plan.name.toLowerCase()}`

/** What a server may run past plain Minecraft, or that it is plain: no loader is ever named on a card. */
function addOns(plan: PublicPlan): string {
  if (plan.mods)
    return plan.datapacks ? 'Modpacks, mods, plugins and datapacks' : 'Modpacks, mods and plugins'
  return plan.datapacks ? 'Plain Minecraft, with datapacks' : 'Plain Minecraft'
}

/** A plan's hours of play, as the line its dashed explainer sits on. */
export const hoursPoint = (plan: PublicPlan) =>
  plan.totalHours !== null
    ? `${plan.totalHours} hours of play, any day you like`
    : `${plan.includedHours} hours of play each month${extraHourOf(plan) === null ? '' : `, then ${extraHourOf(plan)}¢ an hour`}`

/** One of a plan's points as a card shows it: the hours on the dashed line that says what they are. */
export function PlanPoint({ plan, point }: { plan: PublicPlan; point: string }) {
  return point === hoursPoint(plan) ? (
    <PlayHours hours={plan.includedHours} total={plan.totalHours} priceCents={plan.monthlyPriceCents}>
      {point}
    </PlayHours>
  ) : (
    point
  )
}

/**
 * The free trial, said on the plan it starts: "Starts with a free trial: 20 hours of play, any day
 * you like, no card", its hours on their dashed line. One element, so a card's row lays it out whole.
 */
export function TrialPoint({ trial }: { trial: PublicPlan }) {
  return (
    <span>
      Starts with a free trial: <PlanPoint plan={trial} point={hoursPoint(trial)} />, no card
    </span>
  )
}

/**
 * How much play a month's hours are, in evenings rather than numbers. A multiplayer session runs
 * about an hour and a half on average and a player plays about 11 hours a month (industry figures,
 * 2026), so a group that plays a couple of evenings a week is the common case.
 */
export const PLAY_HABITS = [
  { hours: 20, said: 'A couple of evenings a week' },
  { hours: 45, said: 'Most evenings, for a couple of hours' },
  { hours: 90, said: 'Hours every day' },
] as const
const COVERS = ['', 'the first', 'the first two', 'all three']

/**
 * What a plan's hours of play are, on the dashed line wherever a plan states them. A month's are
 * set against the three habits, and hours in all as what happens when they are played. A paid
 * plan's ends with where the code is.
 */
export function PlayHours({
  hours,
  total = null,
  priceCents,
  children,
}: {
  hours: number
  /** Hours included once, in all, to play on any day; null: none, and `hours` come each month. */
  total?: number | null
  priceCents: number
  children: ReactNode
}) {
  const covered = PLAY_HABITS.filter((habit) => habit.hours <= hours).length
  if (total !== null)
    return (
      <Tip
        tip={
          <>
            <p>Hours count while your server is on, and everyone on it shares them.</p>
            <p>
              They come once, not every month: {total} in all, to play on any day, for as long as you like.
              Once they’re played, the trial ends and nothing is charged. Your world is kept and you can still
              download it, and a paid plan starts it again.
            </p>
          </>
        }
      >
        {children}
      </Tip>
    )
  return (
    <Tip
      tip={
        <>
          <p>Hours count while your server is on, and everyone on it shares them.</p>
          <ul className="bk-tip__list">
            {PLAY_HABITS.map((habit) => (
              <li key={habit.hours}>
                {habit.said}: {habit.hours === 90 ? '90 or more' : `about ${habit.hours}`}
              </li>
            ))}
          </ul>
          <p>
            {covered > 0
              ? `${hours} covers ${COVERS[covered]}.`
              : `${hours} is about ${Math.round(hours / 2.5)} evenings of play.`}
          </p>
          {priceCents > 0 && (
            <p>
              Cubepals is open source: <OutLink href={SOURCE_URL}>read the code</OutLink>.
            </p>
          )}
        </>
      }
    >
      {children}
    </Tip>
  )
}

/** An amount as it is written: "$0", "$15", "$4.50". */
export const dollars = (cents: number): string =>
  `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

/**
 * The group a paid plan's price is shown split across: friends who play together on one server.
 * An example, not a plan's limit, so it only shows where the plan holds that many players.
 */
const SHARED_BY = { count: 5, said: 'five' } as const

/**
 * What a paid plan comes to for each of a group sharing it, from its own price: "$3" for "five".
 * Null for a free plan, or one too small for the group.
 */
export function eachOf(
  plan: Pick<PublicPlan, 'monthlyPriceCents' | 'maxPlayers'>,
): { each: string; friends: string } | null {
  if (plan.monthlyPriceCents === 0 || plan.maxPlayers < SHARED_BY.count) return null
  return { each: dollars(Math.round(plan.monthlyPriceCents / SHARED_BY.count)), friends: SHARED_BY.said }
}

/** A price as it is said: "$0", "$15 a month". */
export const priceOf = (cents: number): string => (cents === 0 ? '$0' : `${dollars(cents)} a month`)
