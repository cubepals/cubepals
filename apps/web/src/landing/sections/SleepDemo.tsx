// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * Sleep, at two scales. A week: seven evenings in which the viewer says when anyone plays, and
 * under them what that week keeps awake, beside the same week on a server that never sleeps. Then
 * the days after the last session: the machine, the disk and the stored copy, a scrubber over the
 * days nobody plays, and a join on any of them.
 *
 * The plan's numbers (hours, minutes before sleep, days before rest, players) come from `plans`.
 * The order of every sequence is the control plane's own (apps/control/src/app/operations/
 * handlers.ts and schedules.ts), the status names are its own (apps/control/src/domain/server/
 * lifecycle.ts), and what the owner reads is the product's (apps/web/src/lib/present.ts).
 * The times are not: the demonstration is sped up, and it promises none.
 *
 * Left alone, both play themselves (`useTour`), each under its own bar: the week goes round the
 * product's three habits, and the server goes through a rest, a join that brings it back from the
 * stored copy, a sleep, and a join that finds it still on its disk. A press or a key anywhere in
 * the panel hands both back to the person.
 */

import type { PublicPlan } from '@blockly/contracts'
import { type KeyboardEvent, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
import { useInView, useReducedMotion } from '../hooks'
import { stage } from '../stage'
import { TourBar, useTour } from '../tour'
import styles from './sleep.module.css'

// ─── A week ──────────────────────────────────────────────────────────────────────────────────

/** An evening as the week draws it: six hours from six o'clock, an hour to a square. */
const FIRST_HOUR = 18
const SLOTS = 6
/** Half an hour past midnight is drawn too, so a session that ends at midnight shows its tail. */
const PAST_MIDNIGHT = 0.5

const DAYS = [
  { short: 'Mon', full: 'Monday' },
  { short: 'Tue', full: 'Tuesday' },
  { short: 'Wed', full: 'Wednesday' },
  { short: 'Thu', full: 'Thursday' },
  { short: 'Fri', full: 'Friday' },
  { short: 'Sat', full: 'Saturday' },
  { short: 'Sun', full: 'Sunday' },
] as const

const HOURS = [
  { key: '18', said: '6 to 7 pm' },
  { key: '19', said: '7 to 8 pm' },
  { key: '20', said: '8 to 9 pm' },
  { key: '21', said: '9 to 10 pm' },
  { key: '22', said: '10 to 11 pm' },
  { key: '23', said: '11 pm to midnight' },
] as const

const TICKS = ['6 pm', '8 pm', '10 pm'] as const

/** The hours in a week, and the weeks in a month: a twelfth of a year. Arithmetic, not the product's. */
const WEEK_HOURS = 168
const WEEKS_A_MONTH = 365 / 12 / 7

/**
 * A plan whose largest server holds this many players can run a large one, and a large server
 * counts two of the plan's hours for each hour it runs (apps/control/src/domain/server/size.ts,
 * apps/control/src/domain/account/meter.ts). The words for it are the pricing page's
 * (apps/web/src/app/(public)/pricing/page.tsx).
 */
const LARGE_FROM_PLAYERS = 20

/** An evening's six hours, a character each: 1 where someone plays. */
const NOBODY = '000000'
const EIGHT_TO_TEN = '001100'
const SEVEN_TO_TEN = '001110'

/**
 * The product's own three play habits and what it says each comes to in a month
 * (apps/web/src/ui/plans.tsx, which also words the totals). The week drawn for
 * each is this page's: evenings of two hours, or three for "hours every day", which with the
 * minutes before each sleep come to about what the product says. `soon` is the habit in few enough
 * words for the tour's bar, which names the one that comes next.
 */
const HABITS: readonly { said: string; soon: string; total: string; week: readonly string[] }[] = [
  {
    said: 'A couple of evenings a week',
    soon: 'A couple of evenings',
    total: 'about 20',
    week: [NOBODY, NOBODY, NOBODY, NOBODY, EIGHT_TO_TEN, EIGHT_TO_TEN, NOBODY],
  },
  {
    said: 'Most evenings, for a couple of hours',
    soon: 'Most evenings',
    total: 'about 45',
    week: [EIGHT_TO_TEN, EIGHT_TO_TEN, NOBODY, EIGHT_TO_TEN, EIGHT_TO_TEN, EIGHT_TO_TEN, NOBODY],
  },
  {
    said: 'Hours every day',
    soon: 'Hours every day',
    total: '90 or more',
    week: [SEVEN_TO_TEN, SEVEN_TO_TEN, SEVEN_TO_TEN, SEVEN_TO_TEN, SEVEN_TO_TEN, SEVEN_TO_TEN, SEVEN_TO_TEN],
  },
]

const FIRST_WEEK = HABITS[0]?.week ?? []

const plays = (evening: string, slot: number): boolean => evening[slot] === '1'

const flip = (evening: string, slot: number): string =>
  evening.slice(0, slot) + (plays(evening, slot) ? '0' : '1') + evening.slice(slot + 1)

/**
 * One stretch a server is awake for: a session, from its first hour to the end of its last, and
 * the tail after it. All in hours from the start of the evening.
 */
interface Stretch {
  start: number
  end: number
  tail: number
}

/**
 * An evening's sessions, each followed by the plan's time before sleep: the server stops once
 * nobody has been seen for that long (apps/control/src/app/operations/schedules.ts). A
 * tail ends early where the next session starts inside it, since the server never slept between.
 */
function stretchesOf(evening: string, tailHours: number): Stretch[] {
  const found: Stretch[] = []
  let at = 0
  while (at < SLOTS) {
    if (!plays(evening, at)) {
      at += 1
      continue
    }
    let end = at
    while (end < SLOTS && plays(evening, end)) end += 1
    found.push({ start: at, end, tail: tailHours })
    at = end
  }
  return found.map((stretch, index) => {
    const next = found[index + 1]
    return next ? { ...stretch, tail: Math.min(tailHours, next.start - stretch.end) } : stretch
  })
}

/** How much of the time from `from` to `to` is a tail: 0 for none of it, 1 for all. */
function tailIn(stretches: readonly Stretch[], from: number, to: number): number {
  let covered = 0
  for (const stretch of stretches) {
    const begins = Math.max(from, stretch.end)
    const ends = Math.min(to, stretch.end + stretch.tail)
    if (ends > begins) covered += ends - begins
  }
  return covered / (to - from)
}

/** Minutes as they are written beside a bar: "4 h 20 min". */
function spanOf(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (rest === 0) return `${hours} h`
  return hours === 0 ? `${rest} min` : `${hours} h ${rest} min`
}

/** The minutes a week keeps a server awake: every session, and the tail after each. */
function awakeIn(week: readonly string[], tailHours: number): number {
  let minutes = 0
  for (const evening of week)
    for (const each of stretchesOf(evening, tailHours)) minutes += (each.end - each.start + each.tail) * 60
  return Math.round(minutes)
}

/** A month of weeks that keep it awake that long, in whole hours. */
const monthOf = (awakeMinutes: number): number => Math.round((awakeMinutes / 60) * WEEKS_A_MONTH)

/** What a month of that many hours comes to against the plan's own, in words. */
function monthSaid(month: number, plan: PublicPlan, plans: readonly PublicPlan[]): string {
  const included = plan.includedHours
  if (month === 0) return `Nothing ran, so none of the ${included} hours on ${plan.name} were used.`
  if (month > included) {
    // A bigger plan that would hold this month, said the way the account page says it. Only a paid
    // plan allows extra hours (mayBuyMore, entitlements.ts), as the pricing page says.
    const roomier = plans.find((each) => each.includedHours > included && each.includedHours >= month)
    const extra = plan.monthlyPriceCents > 0 ? ', unless you allow extra hours, up to a limit you set' : ''
    return `More than the ${included} hours on ${plan.name}. When they run out, the server sleeps until the 1st, when the hours start again${extra}.${roomier ? ` ${roomier.name} has ${roomier.includedHours} hours a month.` : ''}`
  }
  // The week counts an hour awake as one of the plan's hours. On a plan that runs large servers
  // that isn't the whole of it, and the note says so.
  const large = plan.maxPlayers >= LARGE_FROM_PLAYERS
  return `Inside the ${included} hours on ${plan.name}.${
    large
      ? ` A large server, for big modpacks and groups of ${LARGE_FROM_PLAYERS} or more, counts two hours for each hour it runs.`
      : ''
  }`
}

/** Where the arrow keys take the keyboard in the week: along an evening, or to the next one. */
const MOVES: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -SLOTS, ArrowDown: SLOTS }

// ─── If nobody plays ─────────────────────────────────────────────────────────────────────────

/**
 * Where the demonstration's server is. Each is one moment of the control plane's own sequences:
 * a stop (handlers.ts), a store (handlers.ts: copy, read back, and only then
 * `storing` and the release), a start, and an unstore (handlers.ts).
 */
type Phase =
  | 'asleep'
  | 'copying'
  | 'checking'
  | 'releasing'
  | 'resting'
  | 'starting'
  | 'restoring'
  | 'awake'
  | 'empty'
  | 'saving'

/** The control plane's own name for the server's status at each. lifecycle.ts */
const STATUS: Record<Phase, string> = {
  asleep: 'stopped',
  // The copy is made and read back while the server is still `stopped` (handlers.ts).
  copying: 'stopped',
  checking: 'stopped',
  // `storing` begins only once the copy has been verified, under the server's lock (:1235).
  releasing: 'storing',
  resting: 'stored',
  starting: 'starting',
  restoring: 'restoring',
  awake: 'running',
  empty: 'running',
  saving: 'stopping',
}

/**
 * The plain word for each, as the product says it: the status line's own (present.ts), the
 * pill's "Starting" (apps/web/src/ui/status.tsx), and the power button's "Asleep" and "Awake"
 * (apps/web/src/app/(app)/servers/[id]/page.tsx).
 */
const WORD: Record<Phase, string> = {
  asleep: 'Asleep',
  copying: 'Asleep',
  checking: 'Asleep',
  releasing: 'Asleep',
  resting: 'Resting',
  starting: 'Starting',
  restoring: 'Restoring',
  awake: 'Awake',
  empty: 'Awake',
  saving: 'Stopping',
}

/** The steps the owner's page shows for a start. present.ts */
const START_STEPS = ['Waking the server', 'Loading the world', 'Letting players in']
/** And for a world coming back from rest. present.ts */
const UNSTORE_STEPS = ['Getting your world', 'Setting it up', 'Starting it up', 'Loading the world']

/** How many days a world's stored copy is kept once it is back on a disk. handlers.ts */
const KEPT_DAYS = 7

/** The sleep room's lamp in the chunk: turned low while asleep, out while resting, up while awake. */
const LAMPS_LOW = 0.25
const LAMPS_HALF = 0.6
const lampsFor = (phase: Phase, step: number): number => {
  switch (phase) {
    case 'awake':
    case 'empty':
      return 1
    case 'starting':
    case 'saving':
      return LAMPS_HALF
    case 'restoring':
      return step < 2 ? LAMPS_LOW : LAMPS_HALF
    case 'releasing':
    case 'resting':
      return 0
    default:
      return LAMPS_LOW
  }
}

interface Rest {
  /** Days since anyone played. */
  day: number
  phase: Phase
  /** Which step of the owner's progress a wake has reached. */
  step: number
  /** Where the last join found the world: on its disk, or in the stored copy. */
  from: 'disk' | 'copy'
  /** Days the copy a world rested in is still kept, counted from when it woke. */
  kept: number
  /** The moments still to come. */
  queue: readonly Beat[]
}

interface Beat {
  wait: number
  patch: Partial<Omit<Rest, 'queue'>>
}

/** Sped up: each moment is held long enough to read. */
const STORE: readonly Beat[] = [
  { wait: 1700, patch: { phase: 'checking' } },
  { wait: 1400, patch: { phase: 'releasing' } },
  { wait: 1400, patch: { phase: 'resting', kept: 0 } },
]
const WAKE: readonly Beat[] = [
  { wait: 1300, patch: { step: 1 } },
  { wait: 1100, patch: { step: 2 } },
  { wait: 1000, patch: { phase: 'awake', day: 0 } },
]
const UNSTORE: readonly Beat[] = [
  { wait: 1900, patch: { step: 1 } },
  { wait: 1300, patch: { step: 2 } },
  { wait: 1100, patch: { step: 3 } },
  { wait: 1000, patch: { phase: 'awake', day: 0, kept: KEPT_DAYS } },
]
const LEAVE: readonly Beat[] = [
  { wait: 1900, patch: { phase: 'saving' } },
  { wait: 1500, patch: { phase: 'asleep' } },
]

/**
 * The days going by when the tour drags through them: about this many stops on the way to the day
 * a world rests, this long at each.
 */
const STOPS = 7
const STOP_MS = 180

/** How long a sequence takes to play, in seconds. */
const lasts = (beats: readonly Beat[]): number => beats.reduce((sum, beat) => sum + beat.wait, 0) / 1000

/** While nobody has played: the phases the days can be dragged through. */
const UNPLAYED: ReadonlySet<Phase> = new Set(['asleep', 'copying', 'checking', 'releasing', 'resting'])

type Act =
  | { type: 'scrub'; day: number; rests: number; still: boolean }
  | { type: 'pass'; rests: number; still: boolean }
  | { type: 'join'; still: boolean }
  | { type: 'leave'; still: boolean }
  | { type: 'plan'; rests: number; last: number }
  | { type: 'beat' }
  | { type: 'flush' }

const FIRST: Rest = { day: 0, phase: 'asleep', step: 0, from: 'disk', kept: 0, queue: [] }

/** Everything still to come, at once: where the sequence ends. */
function settle(rest: Rest): Rest {
  const settled: Rest = { ...rest, queue: [] }
  for (const beat of rest.queue) Object.assign(settled, beat.patch)
  return settled
}

/** Starts a sequence. `still` shows only its end: less motion was asked for, or it is out of sight. */
function begin(rest: Rest, first: Beat['patch'], beats: readonly Beat[], still: boolean): Rest {
  const begun = { ...rest, ...first, queue: beats }
  return still ? settle(begun) : begun
}

function reduce(rest: Rest, act: Act): Rest {
  switch (act.type) {
    case 'scrub': {
      if (!UNPLAYED.has(rest.phase)) return rest
      // Dragged back before the day a world rests: it is on its disk again, as it was then.
      if (act.day < act.rests) return { ...rest, day: act.day, phase: 'asleep', queue: [] }
      if (rest.phase !== 'asleep') return { ...rest, day: act.day }
      return begin({ ...rest, day: act.day }, { phase: 'copying' }, STORE, act.still)
    }
    case 'pass': {
      // The same drag, made by the tour: the days go by a few at a time, and on the day a world
      // rests the store begins. Anything a person does meanwhile takes its place.
      if (rest.phase !== 'asleep') return rest
      const stride = Math.max(1, Math.round(act.rests / STOPS))
      const days: Beat[] = []
      for (let day = rest.day + stride; day < act.rests; day += stride)
        days.push({ wait: STOP_MS, patch: { day } })
      const rested: Beat = { wait: STOP_MS, patch: { day: Math.max(rest.day, act.rests), phase: 'copying' } }
      return begin(rest, {}, [...days, rested, ...STORE], act.still)
    }
    case 'join': {
      // A join ends the days without play; a copy still kept from an earlier rest is that much older.
      if (rest.phase === 'asleep') {
        const kept = Math.max(0, rest.kept - rest.day)
        return begin(rest, { phase: 'starting', step: 0, from: 'disk', kept }, WAKE, act.still)
      }
      // Until the copy has been read back the server is still `stopped`, on its machine and its
      // disk: a join starts it from there, the store finds it isn't asleep any more and gives way,
      // and the copy it made stays a while as an ordinary backup (handlers.ts).
      if (rest.phase === 'copying' || rest.phase === 'checking')
        return begin(rest, { phase: 'starting', step: 0, from: 'disk', kept: KEPT_DAYS }, WAKE, act.still)
      if (UNPLAYED.has(rest.phase))
        return begin(rest, { phase: 'restoring', step: 0, from: 'copy', kept: 0 }, UNSTORE, act.still)
      return rest
    }
    case 'leave':
      return rest.phase === 'awake' ? begin(rest, { phase: 'empty' }, LEAVE, act.still) : rest
    case 'plan': {
      // Another plan rests a world on another day: the same day is read against it.
      if (!UNPLAYED.has(rest.phase)) return rest
      const day = Math.min(rest.day, act.last)
      return day < act.rests
        ? { ...rest, day, phase: 'asleep', queue: [] }
        : { ...rest, day, phase: 'resting', kept: 0, queue: [] }
    }
    case 'beat': {
      const [next, ...queue] = rest.queue
      return next ? { ...rest, ...next.patch, queue } : rest
    }
    case 'flush':
      return settle(rest)
  }
}

/** What the tour does to the server: the same three things a person can. */
type Turn = Extract<Act, { type: 'pass' | 'join' | 'leave' }>

/**
 * The tour's next turn, read off where the server is and never off what the tour did last, since a
 * person may have left it anywhere. Asleep, the two wakes take turns: after a wake from the disk
 * the days go by and the world rests, so the next join finds only the copy; after a wake from the
 * copy the next join comes while the world is still on its disk. Nothing while a sequence is still
 * playing: that is left to finish.
 */
function turnOf(rest: Rest, rests: number, still: boolean): Turn | null {
  if (rest.queue.length > 0) return null
  if (rest.phase === 'awake') return { type: 'leave', still }
  if (rest.phase === 'asleep' && rest.from === 'disk') return { type: 'pass', rests, still }
  return UNPLAYED.has(rest.phase) ? { type: 'join', still } : null
}

/** What the tour's bar says is coming. The join and the leave are the buttons' own words. */
const SOON: Record<Turn['type'], string> = {
  pass: 'Days go by',
  join: 'A friend joins',
  leave: 'Everyone leaves',
}

/**
 * How long the bar runs after a turn: the sequence the turn began, and then this long to read where
 * it ends. Never past the longest window a tour's step may have.
 */
const READ_SECONDS = 3.6
const LONGEST_SECONDS = 10

/** How one of the three things is drawn: not there, there and idle, holding the world, or running. */
type Look = 'none' | 'idle' | 'holds' | 'lit'

interface Thing {
  look: Look
  says: string
  /** Being written, over this many milliseconds. */
  fills?: number
}

const dayCount = (days: number): string => (days === 1 ? '1 more day' : `${days} more days`)

/** The machine, the disk and the stored copy at each moment. */
function thingsOf(rest: Rest): { machine: Thing; disk: Thing; copy: Thing } {
  const world: Thing = { look: 'holds', says: 'holds the world' }
  const gone: Thing = { look: 'none', says: 'let go' }
  // A copy that outlived its world's rest is an ordinary backup for a while (handlers.ts).
  const left = rest.phase === 'asleep' ? rest.kept - rest.day : rest.kept
  const backup: Thing =
    left > 0 ? { look: 'idle', says: `a backup, ${dayCount(left)}` } : { look: 'none', says: 'none' }

  switch (rest.phase) {
    case 'asleep':
      return { machine: { look: 'idle', says: 'stopped' }, disk: world, copy: backup }
    case 'copying':
      return {
        machine: { look: 'idle', says: 'stopped' },
        disk: world,
        copy: { look: 'idle', says: 'being written', fills: STORE[0]?.wait },
      }
    case 'checking':
      return {
        machine: { look: 'idle', says: 'stopped' },
        disk: world,
        copy: { look: 'idle', says: 'being read back' },
      }
    case 'releasing':
    case 'resting':
      return { machine: gone, disk: gone, copy: world }
    case 'starting':
      return { machine: { look: 'idle', says: 'starting' }, disk: world, copy: backup }
    case 'restoring':
      return rest.step === 0
        ? {
            machine: { look: 'none', says: 'not made yet' },
            disk: { look: 'idle', says: 'new, filling from the copy', fills: UNSTORE[0]?.wait },
            copy: world,
          }
        : {
            machine: { look: 'idle', says: rest.step === 1 ? 'new, being set up' : 'starting' },
            disk: world,
            copy: world,
          }
    case 'awake':
    case 'empty':
      return { machine: { look: 'lit', says: 'running' }, disk: world, copy: backup }
    case 'saving':
      return { machine: { look: 'idle', says: 'stopping' }, disk: world, copy: backup }
  }
}

/** What is happening, in a sentence or two that stand without the drawing. */
function saidOf(rest: Rest, rests: number | null, minutes: number | null): string {
  switch (rest.phase) {
    case 'asleep':
      return 'The machine is stopped. The world is on its disk, saved before it stopped.'
    case 'copying':
      return rests === null
        ? 'After enough days without play, the world is copied into storage.'
        : `Day ${rests}. The world is copied into storage.`
    case 'checking':
      return 'The copy is read back from storage, to check that it is whole.'
    case 'releasing':
      return 'Only now are the machine and the disk let go.'
    case 'resting':
      return 'The copy was read back whole before the machine and the disk were let go. The stored copy is the world now.'
    case 'starting':
      return 'A join starts the machine. The world is already on its disk.'
    case 'restoring':
      return 'A join finds no machine and no disk: a new disk is filled from the stored copy, then a new machine starts on it.'
    case 'awake':
      return rest.from === 'copy'
        ? 'A new disk was filled from the stored copy and a new machine started on it. Someone is on, so it runs, and the hours count.'
        : 'The machine started, with the world already on its disk. Someone is on, so it runs, and the hours count.'
    case 'empty':
      return minutes === null
        ? 'Everyone has left. It stays awake a little longer, and that counts too.'
        : `Everyone has left. It stays awake for ${minutes} more minutes, and those count too.`
    case 'saving':
      return 'Then it saves the world and stops, and the hours stop counting.'
  }
}

/** What the server's owner reads on its page at each moment: the product's own strings. */
function ownerOf(rest: Rest, maxPlayers: number | null): { reads: string; step?: string } | null {
  switch (rest.phase) {
    case 'asleep':
    case 'copying':
    case 'checking':
      // present.ts
      return { reads: 'Nobody was on, so it went to sleep. Joining wakes it' }
    case 'releasing':
      // present.ts
      return { reads: 'Asleep until someone joins, or you wake it here' }
    case 'resting':
      // present.ts
      return { reads: 'Resting while nobody plays. Joining wakes it, in a couple of minutes' }
    case 'starting':
      // present.ts
      return { reads: 'Starting your server', step: START_STEPS[rest.step] }
    case 'restoring':
      // present.ts
      return { reads: 'Restoring your world · a couple of minutes', step: UNSTORE_STEPS[rest.step] }
    case 'awake':
      // present.ts
      return maxPlayers === null ? null : { reads: `1 / ${maxPlayers} players` }
    case 'empty':
      return maxPlayers === null ? null : { reads: `0 / ${maxPlayers} players` }
    case 'saving':
      // present.ts
      return { reads: 'Saving your world' }
  }
}

function ThingBox({ name, thing }: { name: string; thing: Thing }) {
  const frame =
    thing.look === 'lit'
      ? 'bl-frame bl-frame--lit'
      : thing.look === 'holds'
        ? 'bl-frame bl-frame--solid'
        : 'bl-frame'
  return (
    <div className={`${frame} ${styles.thing}`} data-look={thing.look}>
      {thing.look === 'none' && <i className={`bl-dither ${styles.tint}`} data-level="2" aria-hidden />}
      <span className={styles.thingName}>{name}</span>
      <span className={styles.thingSays}>{thing.says}</span>
      {thing.fills !== undefined && (
        <span className={styles.gauge} aria-hidden>
          <i className={`bl-dither ${styles.gaugeTrack}`} data-level="3" />
          <i className={styles.gaugeBar} style={{ animationDuration: `${thing.fills}ms` }} />
        </span>
      )}
    </div>
  )
}

export function SleepDemo({ plans }: { plans: PublicPlan[] }) {
  const root = useRef<HTMLDivElement>(null)
  const inView = useInView(root)
  const reduced = useReducedMotion()
  const id = useId()

  // The free plan first: it is the one the server on the surface runs on.
  const [chosen, setChosen] = useState<string | null>(null)
  const plan =
    plans.find((each) => each.key === chosen) ??
    plans.find((each) => each.monthlyPriceCents === 0) ??
    plans[0] ??
    null
  const tailMinutes = plan?.sleepsAfterMinutes ?? null
  const rests = plan ? Math.max(1, plan.restsAfterDays) : null

  // ─── A week ────────────────────────────────────────────────────────────────────────────────

  const [week, setWeek] = useState<readonly string[]>(FIRST_WEEK)
  /** The hour the arrow keys start from, the hour that has the keyboard, and the hour pointed at. */
  const [cursor, setCursor] = useState(0)
  const [focused, setFocused] = useState<number | null>(null)
  const [pointed, setPointed] = useState<number | null>(null)

  const tailHours = tailMinutes === null ? 0 : tailMinutes / 60
  const evenings = week.map((evening) => ({ evening, stretches: stretchesOf(evening, tailHours) }))
  const awakeMinutes = awakeIn(week, tailHours)
  const month = monthOf(awakeMinutes)
  const included = plan?.includedHours ?? null
  const over = included !== null && month > included
  const scale = Math.max(included ?? 0, month, 1)
  // What the month's note says for each of the three habits on this plan. They lie unseen under
  // the note that shows, so its room is that of the longest: the tour changes the week every few
  // seconds, and the half below must not move with it.
  const habitNotes = useMemo(
    () =>
      plan === null
        ? []
        : [
            ...new Set(
              HABITS.map((habit) => monthSaid(monthOf(awakeIn(habit.week, tailHours)), plan, plans)),
            ),
          ],
    [plan, plans, tailHours],
  )

  // The habit the week is on now, if it is one of the three, and the one after it.
  const habitNow = HABITS.findIndex((habit) => week.every((evening, index) => evening === habit.week[index]))
  const habitNext = HABITS[(habitNow + 1) % HABITS.length]

  // The hour being looked at: the one under the pointer, or else the one last pressed or tabbed to.
  const probe = pointed ?? focused
  const probed = probe === null ? undefined : evenings[Math.floor(probe / SLOTS)]
  const probeSlot = probe === null ? 0 : probe % SLOTS
  const probeAwake =
    probed !== undefined &&
    (plays(probed.evening, probeSlot) || tailIn(probed.stretches, probeSlot, probeSlot + 1) > 0)

  const toggle = (day: number, slot: number) =>
    setWeek((now) => now.map((evening, index) => (index === day ? flip(evening, slot) : evening)))

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const move = MOVES[event.key]
    if (move === undefined) return
    event.preventDefault()
    const next = index + move
    const sameEvening = Math.floor(next / SLOTS) === Math.floor(index / SLOTS)
    if (next < 0 || next >= DAYS.length * SLOTS || (Math.abs(move) === 1 && !sameEvening)) return
    setCursor(next)
    root.current?.querySelector<HTMLButtonElement>(`[data-hour="${next}"]`)?.focus()
  }

  // ─── If nobody plays ───────────────────────────────────────────────────────────────────────

  const [rest, dispatch] = useReducer(reduce, FIRST)
  const restsOn = rests ?? 1
  const lastDay = rests === null ? 1 : rests + Math.max(3, Math.round(rests / 4))
  const still = reduced || !inView

  // Each moment of a sequence in its turn; all of it at once if it can no longer be seen.
  const waiting = rest.queue[0]
  useEffect(() => {
    if (!waiting) return
    if (!inView || reduced) {
      dispatch({ type: 'flush' })
      return
    }
    const timer = setTimeout(() => dispatch({ type: 'beat' }), waiting.wait)
    return () => clearTimeout(timer)
  }, [waiting, inView, reduced])

  // The sleep room in the chunk: its lamp follows this server, and comes up for an hour of the
  // week that is awake while it is pointed at. Handed back when the demonstration is out of sight.
  const lamps = inView ? Math.max(lampsFor(rest.phase, rest.step), probeAwake ? 1 : 0) : null
  useEffect(() => {
    stage.glow('sleep', lamps)
  }, [lamps])
  useEffect(() => () => stage.glow('sleep', null), [])

  // Anything done to the server below takes the chunk's lamp back from the week above.
  const send = (act: Act) => {
    setFocused(null)
    dispatch(act)
  }
  const choose = (next: PublicPlan) => {
    setChosen(next.key)
    const days = Math.max(1, next.restsAfterDays)
    send({ type: 'plan', rests: days, last: days + Math.max(3, Math.round(days / 4)) })
  }
  const scrub = (day: number) => send({ type: 'scrub', day, rests: restsOn, still })

  // ─── Left alone ────────────────────────────────────────────────────────────────────────────

  // Neither half waits for a press. The week goes round the three habits, from whichever it is on;
  // a week somebody drew by hand gives way to the first of them.
  const weekTour = useTour({
    ref: root,
    steps: [
      () => {
        if (habitNext) setWeek(habitNext.week)
      },
    ],
    seconds: 6,
    first: 2.5,
  })

  // The server takes its turns (`turnOf`), with the same acts a press sends. `linger` is how long
  // the bar runs after one: it is set in the step itself, so the bar and the countdown behind it
  // change together and never while a window is running.
  const [linger, setLinger] = useState<number>(READ_SECONDS)
  const restTour = useTour({
    ref: root,
    steps: [
      () => {
        const turn = turnOf(rest, restsOn, still)
        // A sequence is still playing: it is left to finish, and looked at again shortly.
        if (turn === null) {
          setLinger(READ_SECONDS)
          return
        }
        setLinger(Math.min(LONGEST_SECONDS, lasts(reduce(rest, turn).queue) + READ_SECONDS))
        send(turn)
      },
    ],
    seconds: linger,
    first: 3.5,
  })
  // What the bar names is the turn that comes once whatever is playing now has finished.
  const soon = SOON[turnOf(settle(rest), restsOn, still)?.type ?? 'join']

  const unplayed = UNPLAYED.has(rest.phase)
  const things = thingsOf(rest)
  // The sleep room's scene in the chunk plays this server: where it is, which step of a wake it
  // has reached, and whether there is a copy in storage (being written, kept as a backup, or the
  // world itself). Out of sight nothing here moves, so the room is left to play by itself.
  const copy = things.copy.look !== 'none'
  useEffect(() => {
    stage.show('sleep', inView ? { phase: rest.phase, step: rest.step, copy } : null)
  }, [inView, rest.phase, rest.step, copy])
  useEffect(() => () => stage.show('sleep', null), [])
  // The example is the server on the surface, which holds the free plan's group whichever plan it
  // is on: a plan's own `maxPlayers` is its largest server's, the one that counts two hours.
  const smallest = plans.find((each) => each.monthlyPriceCents === 0) ?? plan
  const owner = ownerOf(rest, smallest?.maxPlayers ?? null)
  const mark = (restsOn / lastDay) * 100
  const joining = rest.phase === 'starting' || rest.phase === 'restoring'
  const leaving = rest.phase === 'empty' || rest.phase === 'saving'

  return (
    <div className={styles.panel} ref={root}>
      {plans.length > 1 && (
        // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's fieldset
        <div className={styles.plans} role="group" aria-label="The plan">
          <span className={styles.plansLabel}>Plan</span>
          {plans.map((each) => (
            <button
              key={each.key}
              type="button"
              className="bl-chip"
              aria-pressed={each.key === plan?.key}
              onClick={() => choose(each)}
            >
              {each.name}
              <span className={`bl-mono bl-num ${styles.chipHours}`}>
                {each.includedHours} h<span className={styles.sr}> a month</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <section className={styles.row} aria-labelledby={`${id}-week`} data-tour-frame>
        <h3 id={`${id}-week`} className={styles.rowTitle}>
          A week
        </h3>
        <p className={styles.hint}>
          Seven evenings, an hour to a square. Press an hour to play in it, or start from a habit.
        </p>
        <TourBar tour={weekTour} label={habitNext?.soon} name="the week" />

        {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's fieldset */}
        <div className={styles.habits} role="group" aria-label="Play habits">
          {HABITS.map((habit, index) => (
            <button
              key={habit.said}
              type="button"
              className={`bl-chip ${styles.habit}`}
              aria-pressed={index === habitNow}
              onClick={() => setWeek(habit.week)}
            >
              <span>{habit.said}</span>
              <span className={`bl-num ${styles.habitTotal}`}>{habit.total} hours a month</span>
            </button>
          ))}
        </div>

        {/* biome-ignore lint/a11y/useSemanticElements: a grid of toggle buttons, not a form's fieldset */}
        <div
          className={styles.week}
          role="group"
          aria-label="The week’s evenings, an hour to a button. Pressed, someone is playing in it. The arrow keys move between hours."
        >
          <div className={styles.axis} aria-hidden>
            <span />
            <div className={styles.ticks}>
              {TICKS.map((tick) => (
                <span key={tick}>{tick}</span>
              ))}
            </div>
          </div>
          {evenings.map(({ evening, stretches }, day) => {
            const name = DAYS[day]
            if (!name) return null
            const late = tailIn(stretches, SLOTS, SLOTS + PAST_MIDNIGHT)
            return (
              <div key={name.short} className={styles.day}>
                <span className={styles.dayName} aria-hidden>
                  {name.short}
                </span>
                <div className={styles.track}>
                  {HOURS.map((hour, slot) => {
                    const index = day * SLOTS + slot
                    const on = plays(evening, slot)
                    const tail = on ? 0 : tailIn(stretches, slot, slot + 1)
                    return (
                      <button
                        key={hour.key}
                        type="button"
                        className={styles.hour}
                        data-hour={index}
                        aria-pressed={on}
                        aria-label={`${name.full}, ${hour.said}`}
                        tabIndex={index === cursor ? 0 : -1}
                        onClick={() => toggle(day, slot)}
                        onKeyDown={(event) => onKey(event, index)}
                        onFocus={() => {
                          setCursor(index)
                          setFocused(index)
                        }}
                        onBlur={() => setFocused((now) => (now === index ? null : now))}
                        onPointerEnter={() => setPointed(index)}
                        onPointerLeave={() => setPointed((now) => (now === index ? null : now))}
                      >
                        {!on && <i className={`bl-dither ${styles.asleep}`} data-level="2" aria-hidden />}
                        {tail > 0 && (
                          <i className={styles.tail} style={{ width: `${tail * 100}%` }} aria-hidden />
                        )}
                      </button>
                    )
                  })}
                  <span className={styles.after} aria-hidden>
                    <i className={`bl-dither ${styles.asleep}`} data-level="2" />
                    {late > 0 && <i className={styles.tail} style={{ width: `${late * 100}%` }} />}
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        <ul className={styles.legend}>
          <li>
            <i className={styles.swatch} data-kind="on" aria-hidden />
            Someone is on
          </li>
          {tailMinutes !== null && (
            <li>
              <i className={styles.swatch} data-kind="tail" aria-hidden />
              Nobody is on: the {tailMinutes} minutes before it sleeps
            </li>
          )}
          <li>
            <i className={`bl-dither ${styles.swatch}`} data-level="2" aria-hidden />
            Asleep
          </li>
        </ul>

        <div className={styles.tallies}>
          <div className={styles.tally}>
            <span className={styles.tallyName}>Awake this week</span>
            <span className={`bl-mono bl-num ${styles.tallyValue}`}>{spanOf(awakeMinutes)}</span>
            <div className={styles.strip} aria-hidden>
              {evenings.map(({ stretches }, day) => (
                <span key={DAYS[day]?.short} className={styles.stripDay}>
                  <i className={`bl-dither ${styles.stripAsleep}`} data-level="2" />
                  {stretches.map((each) => (
                    <i
                      key={each.start}
                      className={styles.stripAwake}
                      style={{
                        left: `${((FIRST_HOUR + each.start) / 24) * 100}%`,
                        width: `${((each.end - each.start + each.tail) / 24) * 100}%`,
                      }}
                    />
                  ))}
                </span>
              ))}
            </div>
            <span className={styles.tallyNote}>
              The whole week, to scale: seven days of 24 hours
              {tailMinutes === null ? ', without the wait before each sleep' : ''}.
            </span>
          </div>

          <div className={styles.tally}>
            <span className={styles.tallyName}>A server that never sleeps, the same week</span>
            <span className={`bl-mono bl-num ${styles.tallyValue}`}>{WEEK_HOURS} h</span>
            <div className={styles.strip} aria-hidden>
              {DAYS.map((day) => (
                <span key={day.short} className={styles.stripDay} data-always />
              ))}
            </div>
          </div>

          <div className={styles.tally}>
            <span className={styles.tallyName}>A month of weeks like this</span>
            <span className={styles.tallyValue}>
              about <span className="bl-mono bl-num">{month} h</span>
            </span>
            {included !== null && (
              <div className={styles.meter} aria-hidden>
                <i className={`bl-dither ${styles.meterTrack}`} data-level="1" />
                <i
                  className={styles.meterFill}
                  style={{ width: `${(Math.min(month, included) / scale) * 100}%` }}
                />
                {over && (
                  <i
                    className={`bl-dither ${styles.meterOver}`}
                    data-level="3"
                    style={{
                      left: `${(included / scale) * 100}%`,
                      width: `${((month - included) / scale) * 100}%`,
                    }}
                  />
                )}
                <i className={styles.meterMark} style={{ left: `${(included / scale) * 100}%` }} />
              </div>
            )}
            {plan && (
              <span className={`${styles.tallyNote} ${styles.monthNote}`}>
                <span>{monthSaid(month, plan, plans)}</span>
                {habitNotes.map((note) => (
                  <span key={note} className={styles.kept} aria-hidden>
                    {note}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className={styles.row} aria-labelledby={`${id}-rest`} data-tour-frame>
        <h3 id={`${id}-rest`} className={styles.rowTitle}>
          If nobody plays
        </h3>
        <p className={styles.hint}>
          Days go by and nobody joins. Drag through them, and join on any of them.
        </p>
        <TourBar tour={restTour} label={soon} name="the days nobody plays" />

        {rests === null ? (
          // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's fieldset
          <div className={styles.plans} role="group" aria-label="How long nobody has played">
            <span className={styles.plansLabel}>Nobody has played for</span>
            <button
              type="button"
              className="bl-chip"
              aria-pressed={rest.day === 0}
              aria-disabled={!unplayed}
              onClick={() => scrub(0)}
            >
              a few days
            </button>
            <button
              type="button"
              className="bl-chip"
              aria-pressed={rest.day > 0}
              aria-disabled={!unplayed}
              onClick={() => scrub(1)}
            >
              weeks
            </button>
          </div>
        ) : (
          <div className={styles.scrub}>
            <div className={styles.scrubHead}>
              <label htmlFor={`${id}-days`}>Days without play</label>
              {/* An output announces itself; the slider already says its own value. */}
              <output htmlFor={`${id}-days`} className="bl-num" aria-live="off">
                {rest.day}
              </output>
            </div>
            <div className={styles.slide} data-off={!unplayed || undefined}>
              <div className={styles.scale} aria-hidden>
                <i className={`bl-dither ${styles.scaleTrack}`} data-level="1" />
                <i className={styles.scaleGone} style={{ width: `${(rest.day / lastDay) * 100}%` }} />
                <i className={styles.scaleMark} style={{ left: `${mark}%` }} />
              </div>
              <input
                id={`${id}-days`}
                className={styles.range}
                type="range"
                min={0}
                max={lastDay}
                step={1}
                value={rest.day}
                // Not `disabled`: the tour's join and leave turn this off and on every few seconds, and
                // a keyboard resting on it would lose its place. While it is off, a drag does nothing.
                aria-disabled={!unplayed || undefined}
                aria-valuetext={rest.day === 1 ? '1 day without play' : `${rest.day} days without play`}
                onChange={(event) => {
                  if (unplayed) scrub(Number(event.target.value))
                }}
              />
            </div>
            <div className={`bl-num ${styles.scaleAxis}`} aria-hidden>
              <span className={styles.axisStart}>day 0</span>
              <span className={styles.axisRest} style={{ right: `${100 - mark}%` }}>
                it rests on day {rests}
              </span>
              <span className={styles.axisEnd}>day {lastDay}</span>
            </div>
          </div>
        )}

        <div className={styles.actions}>
          {rest.phase === 'awake' || leaving ? (
            <button
              type="button"
              className="bl-btn bl-btn--sm bl-btn--quiet"
              aria-disabled={leaving}
              onClick={() => send({ type: 'leave', still })}
            >
              {leaving ? 'Everyone has left' : 'Everyone leaves'}
            </button>
          ) : (
            <button
              type="button"
              className="bl-btn bl-btn--sm"
              aria-disabled={joining}
              onClick={() => send({ type: 'join', still })}
            >
              {joining ? 'Joining' : 'A friend joins'}
            </button>
          )}
        </div>

        <div className={styles.things}>
          <ThingBox name="Machine" thing={things.machine} />
          <ThingBox name="Disk" thing={things.disk} />
          <ThingBox name="Stored copy" thing={things.copy} />
        </div>

        {/* Quiet while the tour is what moves it; and only what changed is read, not the whole of it. */}
        <div className={styles.now} aria-live={restTour.auto ? 'off' : 'polite'}>
          <p className={`bl-h3 ${styles.state}`}>
            {WORD[rest.phase]}
            <span className={`bl-mono ${styles.status}`}>
              {rest.phase === 'awake' || rest.phase === 'empty' ? (
                <i className={styles.lamp} aria-hidden />
              ) : null}
              {STATUS[rest.phase]}
            </span>
          </p>
          <p className={styles.said}>{saidOf(rest, rests, tailMinutes)}</p>
          {owner && (
            <p className={styles.owner}>
              Its owner reads <span className={styles.quote}>“{owner.reads}”</span>
              {owner.step && (
                <>
                  , at the step <span className={styles.quote}>“{owner.step}”</span>
                </>
              )}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
