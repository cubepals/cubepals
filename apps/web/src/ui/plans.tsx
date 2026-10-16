// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PublicPlan } from '@blockly/contracts'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { SOURCE_URL } from './brand'
import { OutLink } from './out-link'
import { Badge } from './surfaces'
import { Tip } from './tip'

/** What each plan is for, as the person choosing would put it. */
const PITCH: Record<string, string> = {
  free: 'Plain Minecraft for a small group',
  plus: 'Modpacks, bigger groups, more play',
}

/**
 * A plan in the four things people choose on, in their words: no gigabytes, units or minutes.
 * The free trial says what it is rather than what it lacks, so nothing on it is crossed out. Starting when
 * someone joins is every plan's and the page's headline, so no card repeats it.
 */
export function planPoints(plan: PublicPlan): string[] {
  return [
    plan.maxServers === 1
      ? `1 server, up to ${plan.maxPlayers} players`
      : `Up to ${plan.maxServers} servers and ${plan.maxPlayers} players`,
    hoursPoint(plan),
    addOns(plan),
    plan.downloads === 'history'
      ? `Go back to any of your last ${plan.sessionsKept} sessions, and a weekly download`
      : `Go back to any of your last ${plan.sessionsKept} sessions, and download your world`,
  ]
}

/**
 * A plan's name inside a sentence: "Plus", or "the free trial" for the one whose hours come once,
 * which is a trial and not a plan that lasts.
 */
export const planSaid = (plan: Pick<PublicPlan, 'name' | 'totalHours'>): string =>
  plan.totalHours === null ? plan.name : `the ${plan.name.toLowerCase()}`

/** What a server may run past plain Minecraft, or that it is plain. */
function addOns(plan: PublicPlan): string {
  if (plan.mods)
    return plan.datapacks ? 'Modpacks, mods, plugins and datapacks' : 'Modpacks, mods and plugins'
  return plan.datapacks ? 'Vanilla or Paper, with datapacks' : 'Vanilla or Paper'
}

const hoursPoint = (plan: PublicPlan) =>
  plan.totalHours !== null
    ? `${plan.totalHours} hours of play, at most ${plan.includedHours} a day`
    : `${plan.includedHours} hours of play ${plan.per === 'day' ? 'every day' : 'each month'}`

/** One of a plan's points as a card shows it: the hours on the dashed line that says what they are. */
export function PlanPoint({ plan, point }: { plan: PublicPlan; point: string }) {
  return point === hoursPoint(plan) ? (
    <PlayHours
      hours={plan.includedHours}
      per={plan.per}
      total={plan.totalHours}
      priceCents={plan.monthlyPriceCents}
    >
      {point}
    </PlayHours>
  ) : (
    point
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
 * set against the three habits; a day's start again at the player's midnight, so they are said as
 * that, and hours in all as what happens when they are played. A paid plan's opens with why its price is what it is, and ends with where the code is.
 */
export function PlayHours({
  hours,
  per = 'month',
  total = null,
  priceCents,
  children,
}: {
  hours: number
  /** Whether the hours come every day or every month; the paid offers are by the month. */
  per?: PublicPlan['per']
  /** Hours included once, in all, with `hours` the most a day; null: none. */
  total?: number | null
  priceCents: number
  children: ReactNode
}) {
  const covered = PLAY_HABITS.filter((habit) => habit.hours <= hours).length
  if (per === 'day')
    return (
      <Tip
        tip={
          <>
            <p>Hours count while your server is on, and everyone on it shares them.</p>
            {total === null ? (
              <p>They start again at midnight where you are, every day. Unused ones don’t carry over.</p>
            ) : (
              <p>
                They come once, not every month: {total} in all, at most {hours} a day from midnight where you
                are. Once they’re played, the trial ends and nothing is charged. Your world is kept and you
                can still download it, and Plus starts it again.
              </p>
            )}
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
          {priceCents > 0 && (
            <p>
              {dollars(priceCents)} for {hours} hours isn’t cheap, and we know it. Cubepals is small, and
              plans are what pay for the servers. Hours get cheaper to run as more people play, and the price
              will follow.
            </p>
          )}
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
const dollars = (cents: number): string => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

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

/** One plan as the pricing page, the landing page and the account page all show it. */
export function PlanCard({
  plan,
  current = false,
  action,
  mark,
}: {
  plan: PublicPlan
  /** The plan the person is on, marked as theirs. */
  current?: boolean
  action?: ReactNode
  /** The page's mark for the card coming into view, so it is counted (app/(public)/steps.ts). */
  mark?: Readonly<Record<`data-${string}`, string>>
}) {
  const shared = eachOf(plan)
  return (
    <section
      className="bk-plan"
      aria-label={plan.name}
      data-paid={plan.monthlyPriceCents > 0 || undefined}
      {...mark}
    >
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)', justifyContent: 'space-between' }}>
        <h3 className="type-eyebrow">{plan.name}</h3>
        {current && <Badge tone="grass">Yours</Badge>}
      </div>
      <p className="bk-plan__price">
        <span className="type-display-md bk-num">{dollars(plan.monthlyPriceCents)}</span>
        {plan.monthlyPriceCents > 0 && <span className="type-body-sm"> a month</span>}
      </p>
      {shared && (
        <p className="type-body-sm bk-plan__each">
          {shared.each} each, shared by {shared.friends} friends.
        </p>
      )}
      <p className="type-body bk-plan__pitch">{PITCH[plan.key] ?? ''}</p>
      <ul className="bk-plan__points">
        {planPoints(plan).map((point) => (
          <li key={point} className="type-body-sm">
            <Check size={16} strokeWidth={2.25} aria-hidden />
            <PlanPoint plan={plan} point={point} />
          </li>
        ))}
      </ul>
      {action && <div className="bk-plan__action">{action}</div>}
    </section>
  )
}
