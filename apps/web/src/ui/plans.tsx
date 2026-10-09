import type { PublicPlan } from '@blockly/contracts'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from './surfaces'
import { Tip } from './tip'

/** What each plan is for, as the person choosing would put it. */
const PITCH: Record<string, string> = {
  free: 'Plain Minecraft for a small group',
  plus: 'Modpacks, bigger groups, more play',
}

/**
 * A plan in the four things people choose on, in their words: no gigabytes, units or minutes.
 * Free says what it is rather than what it lacks, so nothing on it is crossed out. Starting when
 * someone joins is every plan's and the page's headline, so no card repeats it.
 */
export function planPoints(plan: PublicPlan): string[] {
  return [
    plan.maxServers === 1
      ? `1 server, up to ${plan.maxPlayers} players`
      : `Up to ${plan.maxServers} servers and ${plan.maxPlayers} players`,
    hoursPoint(plan),
    plan.mods ? 'Modpacks, mods and plugins' : 'Vanilla or Paper',
    plan.downloads === 'history' ? 'Weekly backups to download' : 'Daily backups and world downloads',
  ]
}

const hoursPoint = (plan: PublicPlan) => `${plan.includedHours} hours of play each month`

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

/** What a month's hours of play are, on the dashed line wherever a plan states them. */
export function PlayHours({ hours, children }: { hours: number; children: ReactNode }) {
  const covered = PLAY_HABITS.filter((habit) => habit.hours <= hours).length
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
        </>
      }
    >
      {children}
    </Tip>
  )
}

/** An amount as it is written: "$0", "$15", "$4.50". */
const dollars = (cents: number): string => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

/** A price as it is said: "$0", "$15 a month". */
export const priceOf = (cents: number): string => (cents === 0 ? '$0' : `${dollars(cents)} a month`)

/** One plan as the pricing page, the landing page and the account page all show it. */
export function PlanCard({
  plan,
  current = false,
  action,
}: {
  plan: PublicPlan
  /** The plan the person is on, marked as theirs. */
  current?: boolean
  action?: ReactNode
}) {
  return (
    <section className="bk-plan" aria-label={plan.name} data-paid={plan.monthlyPriceCents > 0 || undefined}>
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)', justifyContent: 'space-between' }}>
        <h3 className="type-eyebrow">{plan.name}</h3>
        {current && <Badge tone="grass">Yours</Badge>}
      </div>
      <p className="bk-plan__price">
        <span className="type-display-md bk-num">{dollars(plan.monthlyPriceCents)}</span>
        {plan.monthlyPriceCents > 0 && <span className="type-body-sm"> a month</span>}
      </p>
      <p className="type-body bk-plan__pitch">{PITCH[plan.key] ?? ''}</p>
      <ul className="bk-plan__points">
        {planPoints(plan).map((point) => (
          <li key={point} className="type-body-sm">
            <Check size={16} strokeWidth={2.25} aria-hidden />
            {point === hoursPoint(plan) ? <PlayHours hours={plan.includedHours}>{point}</PlayHours> : point}
          </li>
        ))}
      </ul>
      {action && <div className="bk-plan__action">{action}</div>}
    </section>
  )
}
