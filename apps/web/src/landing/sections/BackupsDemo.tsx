// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The backups stratum's demonstration: the shelf.
 *
 * One example server and the backups it keeps, oldest on the left. The buttons are things that
 * really happen to a server: a day goes by with or without play, its owner backs it up, changes
 * its Minecraft version, restores an older backup, deletes it. Each answers the way the control
 * plane does, in its order and in the product's words: which backup is taken and why, what a
 * running server is told around the copy, which backups the plan keeps, and what comes back when a
 * change doesn't start.
 *
 * Nothing is backed up: this is a simulation, sped up. Three things in it are chosen, and the
 * section's note says so. Each day's backup falls after everyone has left, so a day nobody plays
 * leaves none (apps/control/src/app/operations/schedules.ts takes one only when someone
 * has played since the last). The owner's actions are shown on a running server, because that is
 * when the server is told to pause its writing (apps/control/src/app/operations/handlers.ts).
 * And the Minecraft version only goes up, as it does in the product
 * (apps/control/src/app/revisions/service.ts).
 *
 * Nobody arriving knows the buttons are there to press, so left alone it presses them itself
 * (`following`): a day of play, a change that doesn't start, a restore, a delete, a day in the
 * trash, and back. A person's press takes it over, and the tour carries on from what they did.
 */
import { type ReactNode, useEffect, useReducer, useRef } from 'react'
import { useInView, useReducedMotion } from '../hooks'
import { stage } from '../stage'
import { TourBar, useTour } from '../tour'
import styles from './backups.module.css'
import { addressOf, EXAMPLE_NAME } from './choice'

/** What one plan keeps, as the section hands it over (the numbers are cited in Backups.tsx). */
export interface Shelf {
  key: string
  /** The plan's name on its chip, and as it reads inside a sentence. */
  label: string
  said: string
  /** Daily backups and the owner's own, kept. */
  kept: number
  /** Days a deleted server waits in the trash. */
  trashDays: number
}

// ─── The product's own words ─────────────────────────────────────────────────────────────────

/** The hero's server, at its example address. */
const NAME = EXAMPLE_NAME
const ADDRESS = addressOf(EXAMPLE_NAME)

/** Releases Blockly offers, oldest first. apps/control/src/minecraft/versions.ts */
const VERSIONS = ['1.21.10', '1.21.11', '26.1.2', '26.2', '26.3'] as const

/** What caused a backup, by the control plane's names. apps/control/src/app/backups/persistence.ts */
type Why = 'scheduled' | 'manual' | 'pre_apply' | 'pre_restore'

/** The badge on a backup's row. apps/web/src/lib/present.ts */
const BADGE: Record<Why, string> = {
  scheduled: 'Daily backup',
  manual: 'Backed up by you',
  pre_apply: 'Before a change',
  pre_restore: 'Before a restore',
}

/** The ones kept apart from the owner's own. apps/control/src/app/backups/service.ts */
const SAFETY: readonly Why[] = ['pre_apply', 'pre_restore']

/** The control plane's status names. apps/control/src/domain/server/lifecycle.ts */
type Status = 'running' | 'stopped' | 'updating' | 'restoring' | 'deleted' | 'purged'

/**
 * What the owner's page says for each: the pill's word (apps/web/src/ui/status.tsx), and
 * what a server on its way somewhere is doing
 * (apps/web/src/app/(app)/servers/[id]/settings/shared.tsx). The last two are this page's.
 */
const SAYS: Record<Status, string> = {
  running: 'Online',
  stopped: 'Sleeping',
  updating: 'Applying your changes',
  restoring: 'Bringing the world back',
  deleted: 'In the trash',
  purged: 'Gone for good',
}

/** The owner's steps for one piece of work, and where it has got to. */
interface Journey {
  title: string
  steps: readonly string[]
  at: number
  ended: boolean
  /** What the page says once it is over. */
  result: string | null
}

/** A change being applied; its second step names what is fetched. present.ts */
const applying = (to: string): Journey => ({
  title: 'Applying your changes',
  steps: [
    'Saving the world',
    `Getting Minecraft ${to}`,
    'Starting it up',
    'Loading the world',
    'Letting players in',
  ],
  at: 0,
  ended: false,
  result: null,
})

/** The same work once the change hasn't started. present.ts */
const GOING_BACK: Journey = {
  title: 'Your changes didn’t start. Going back to how it was',
  steps: ['Saving the world', 'Trying your changes', 'Going back'],
  at: 2,
  ended: false,
  result: null,
}

/** A restore. present.ts */
const RESTORING: Journey = {
  title: 'Restoring your backup',
  steps: [
    'Keeping the world as it is now',
    'Bringing the backup back',
    'Setting it up',
    'Starting it up',
    'Loading the world',
  ],
  at: 0,
  ended: false,
  result: null,
}

/**
 * What each ends in. shared.tsx; apps/control/src/app/operations/handlers.ts
 *
 * A change that went back says why in brackets, in the failure's own words with its full stop
 * taken off (handlers.ts). Here the new Minecraft stops at "Starting it up", and that is
 * what the control plane says of a stop there (apps/control/src/app/operations/boot.ts).
 */
const LANDED = {
  apply: 'Your changes are in. Your friends see them now.',
  restore: 'Your backup is back.',
  wentBack:
    "The new configuration didn't start (It stopped while Minecraft was starting, before its world opened). Your server is back on the one before.",
} as const

/** What stands between the commands: the runtime's snapshot of the server's disk. handlers.ts */
const COPY = 'the disk is copied'

// ─── What the demonstration holds ────────────────────────────────────────────────────────────

interface Backup {
  id: number
  day: number
  why: Why
  /** The days of play the world held when it was taken. */
  holds: readonly number[]
}

interface Model {
  day: number
  status: Status
  /** Which of VERSIONS it runs. */
  version: number
  /**
   * The days of play in the world as it is now, each by its day. A list and not a count, because a
   * restore can bring back a world with as many days in it, or more, and still take out days the
   * world holds now.
   */
  holds: readonly number[]
  /** Whether anyone has been on since the last daily backup: the scheduler's test. schedules.ts */
  playedSince: boolean
  /** Oldest first. */
  backups: readonly Backup[]
  /** Days left in the trash, while it is there. */
  trashLeft: number
  /** How many backups have been taken, to tell them apart. */
  made: number
}

/** One moment of what is shown. A press makes a run of them; the last is where things rest. */
interface Frame {
  model: Model
  /** Which of the things a running server is told is being said now; 4 once all are. */
  told: number | null
  journey: Journey | null
  /** The backup the world came back from. */
  from: number | null
  /** The backup just taken. */
  fresh: number | null
  /** What has happened since the press, a sentence at a time. */
  lines: readonly string[]
  hold: number
}

/** Five days of play from before the shelf's oldest backup; which days they were doesn't matter. */
const EARLIER = [2, 3, 5, 6, 8] as const

/** Day 10 has no backup: nobody played that day. */
const SEED: Model = {
  day: 12,
  status: 'stopped',
  version: 0,
  holds: [...EARLIER, 9, 11, 12],
  playedSince: false,
  backups: [
    { id: 1, day: 9, why: 'scheduled', holds: [...EARLIER, 9] },
    { id: 2, day: 11, why: 'scheduled', holds: [...EARLIER, 9, 11] },
    { id: 3, day: 12, why: 'scheduled', holds: [...EARLIER, 9, 11, 12] },
  ],
  trashLeft: 0,
  made: 3,
}

const OPENING: Frame = {
  model: SEED,
  told: null,
  journey: null,
  from: null,
  fresh: null,
  lines: [
    'Day 12 of an example server. Friends played on days 9, 11 and 12, and each of those days left a backup. Nobody played on day 10, so it left none.',
  ],
  hold: 0,
}

/**
 * Sped up: how long a moment with a sentence to read is held, one of the things told, and a step.
 * The longest runs (a change that starts, one that doesn't, a restore) come to about seven and a
 * half seconds, so each ends inside the tour's bar with a while left to look at where it rests.
 */
const READ_MS = 1300
const TOLD_MS = 700
const STEP_MS = 700

/** The tour's bar: the longest it may run, and how long it leaves a run's last moment on show. */
const BAR_MOST_S = 10
const LINGER_S = 4.5

type Act =
  | 'play'
  | 'quiet'
  | 'backup'
  | 'change'
  | 'break'
  | 'restore'
  | 'delete'
  | 'wait'
  | 'undelete'
  | 'again'

const mine = (backups: readonly Backup[]) => backups.filter((backup) => !SAFETY.includes(backup.why))
const safety = (backups: readonly Backup[]) => backups.filter((backup) => SAFETY.includes(backup.why))
const daysOf = (count: number) => (count === 1 ? '1 day' : `${count} days`)

/** The backups a plan still offers of the owner's own: its newest few. */
const offered = (backups: readonly Backup[], shelf: Shelf) => {
  const own = mine(backups)
  return own.slice(Math.max(0, own.length - shelf.kept))
}

/** A run of moments being written: what is shown now, and every moment recorded so far. */
interface Script {
  model: Model
  told: number | null
  journey: Journey | null
  from: number | null
  fresh: number | null
  lines: readonly string[]
  frames: Frame[]
}

const open = (model: Model): Script => ({
  model,
  told: null,
  journey: null,
  from: null,
  fresh: null,
  lines: [],
  frames: [],
})

/** Records the moment as it stands, with one more sentence where there is one to say. */
function shot(script: Script, line: string | null, hold = line === null ? STEP_MS : READ_MS): void {
  if (line !== null) script.lines = [...script.lines, line]
  script.frames.push({
    model: script.model,
    told: script.told,
    journey: script.journey,
    from: script.from,
    fresh: script.fresh,
    lines: script.lines,
    hold,
  })
}

/** Puts a backup of the world as it is now on the shelf. */
function shelve(script: Script, why: Why): number {
  const id = script.model.made + 1
  const backup: Backup = { id, day: script.model.day, why, holds: script.model.holds }
  script.model = { ...script.model, made: id, backups: [...script.model.backups, backup] }
  script.fresh = id
  return id
}

/**
 * A backup of a running server: saving is paused and the world flushed, the disk is copied, and
 * saving goes on again (handlers.ts). `first` says why this one is taken.
 */
function capture(script: Script, why: Why, first: string): number {
  script.told = 0
  shot(script, first, TOLD_MS)
  script.told = 1
  shot(script, 'Then it is told to flush everything it still holds.', TOLD_MS)
  script.told = 2
  const id = shelve(script, why)
  shot(script, `The disk is copied: that is the block marked ${BADGE[why]}.`, TOLD_MS)
  script.told = 3
  shot(script, 'Then it is told to write again.', TOLD_MS)
  script.told = 4
  return id
}

const leaves = (gone: readonly Backup[]): string => {
  const [only] = gone
  return only !== undefined && gone.length === 1
    ? `the one from day ${only.day} leaves the shelf`
    : `the ${gone.length} oldest leave the shelf`
}

/**
 * What the plan keeps, enforced as the control plane does after a backup, a change that went in or
 * a restore: the owner's newest few, and the newest few safety backups (service.ts). True
 * when something left the shelf, which is a moment of its own.
 */
function trim(script: Script, shelf: Shelf, safetyKept: number): boolean {
  const own = mine(script.model.backups)
  const safe = safety(script.model.backups)
  const ownGone = own.slice(0, Math.max(0, own.length - shelf.kept))
  const safeGone = safe.slice(0, Math.max(0, safe.length - safetyKept))
  if (ownGone.length + safeGone.length === 0) return false
  const gone = new Set([...ownGone, ...safeGone].map((backup) => backup.id))
  script.model = { ...script.model, backups: script.model.backups.filter((backup) => !gone.has(backup.id)) }
  const said: string[] = []
  if (ownGone.length > 0)
    said.push(`On ${shelf.said} the shelf keeps the newest ${shelf.kept}, so ${leaves(ownGone)}.`)
  if (safeGone.length > 0)
    said.push(
      `Of those taken before a change or a restore, the newest ${safetyKept} are kept, so ${leaves(safeGone)}.`,
    )
  shot(script, said.join(' '))
  return true
}

/** What one press does, as a run of moments. Empty where the press has nothing to do. */
function play(act: Exclude<Act, 'again'>, model: Model, shelf: Shelf, safetyKept: number): Frame[] {
  const day = model.day + 1
  switch (act) {
    case 'play': {
      const script = open({
        ...model,
        day,
        holds: [...model.holds, day],
        status: 'running',
        playedSince: true,
      })
      shot(script, `Day ${day}. Friends join and play.`)
      script.model = { ...script.model, status: 'stopped' }
      shot(script, 'Everyone leaves. The server saves the world and sleeps.')
      shelve(script, 'scheduled')
      script.model = { ...script.model, playedSince: false }
      shot(
        script,
        'The day’s backup is taken. Asleep, it has nothing to pause: the world was saved as it stopped.',
      )
      trim(script, shelf, safetyKept)
      return script.frames
    }
    case 'quiet': {
      const script = open({ ...model, day, status: 'stopped' })
      if (!model.playedSince) {
        // Nothing is said of the shelf: after enough days like this one the world rests, and its
        // backups stop being offered (handlers.ts). The example doesn't go that far.
        shot(script, `Day ${day}. Nobody joins. Nothing in the world has changed, so no backup is taken.`)
        return script.frames
      }
      shot(script, `Day ${day}. Nobody joins.`)
      shelve(script, 'scheduled')
      script.model = { ...script.model, playedSince: false }
      shot(
        script,
        'Friends were on after the last daily backup, so one more is taken to hold what they did. After it, none until someone plays.',
      )
      trim(script, shelf, safetyKept)
      return script.frames
    }
    case 'backup': {
      const script = open({ ...model, status: 'running', playedSince: true })
      capture(script, 'manual', 'The server is running, so first it is told to stop writing to disk.')
      // Where nothing leaves the shelf there is one more moment all the same, so the run doesn't
      // come to rest with the last thing told still lit as being said.
      if (!trim(script, shelf, safetyKept)) shot(script, null)
      return script.frames
    }
    case 'change':
    case 'break': {
      const from = VERSIONS[model.version]
      const to = VERSIONS[model.version + 1]
      if (from === undefined || to === undefined) return []
      const script = open({ ...model, status: 'updating', playedSince: true })
      const journey = applying(to)
      script.journey = journey
      const before = capture(
        script,
        'pre_apply',
        'A backup comes first. The server is running, so it is told to stop writing to disk.',
      )
      script.journey = { ...journey, at: 1 }
      shot(script, `Now the change: it restarts on Minecraft ${to}.`)
      script.journey = { ...journey, at: 2 }
      shot(script, null)
      if (act === 'change') {
        script.journey = { ...journey, at: 3 }
        shot(script, null)
        script.journey = { ...journey, at: 4 }
        shot(script, null)
        script.model = { ...script.model, status: 'running', version: model.version + 1 }
        script.journey = { ...journey, at: 4, ended: true, result: LANDED.apply }
        shot(
          script,
          'It started, so the change stays. So does the backup, in case the new version turns out to be the wrong one.',
        )
        trim(script, shelf, safetyKept)
        return script.frames
      }
      script.journey = GOING_BACK
      shot(script, `Minecraft ${to} doesn’t start, so the server goes back by itself.`)
      script.from = before
      shot(
        script,
        'A new Minecraft rewrites a world as it loads it, so the world comes back from the backup taken just before.',
      )
      // A change that went back ends there: the shelf is next trimmed after the next backup.
      // handlers.ts
      const crowded = safety(script.model.backups).length > safetyKept
      script.model = { ...script.model, status: 'running' }
      script.journey = { ...GOING_BACK, ended: true, result: LANDED.wentBack }
      shot(
        script,
        `It runs Minecraft ${from} again, with the world as it was.${
          crowded ? ` The lower shelf is trimmed to its newest ${safetyKept} after the next backup.` : ''
        }`,
      )
      return script.frames
    }
    case 'restore': {
      const [target] = offered(model.backups, shelf)
      if (target === undefined) return []
      const script = open({ ...model, status: 'restoring', playedSince: true })
      script.journey = RESTORING
      // The dialog's own sentence comes first. apps/web/src/app/(app)/servers/[id]/backups/page.tsx
      capture(
        script,
        'pre_restore',
        'The world as it is now is kept as a backup first. The server is running, so it is told to stop writing to disk.',
      )
      // What the restore takes out of the world: the days in it now that the backup doesn't hold.
      // They may be from before the backup's day, where an earlier restore put them back. And they
      // aren't only in the backup just taken: a daily backup still on the shelf may hold them too.
      const dropped = model.holds.filter((played) => !target.holds.includes(played)).length
      script.from = target.id
      script.model = { ...script.model, holds: target.holds }
      script.journey = { ...RESTORING, at: 1 }
      shot(
        script,
        dropped > 0
          ? `Then the backup from day ${target.day} comes back, and the world is as it was then. What the world held that this backup doesn’t, ${daysOf(dropped)} of play, is kept in the backup just taken.`
          : `Then the backup from day ${target.day} comes back, and the world is as it was then.`,
      )
      for (const at of [2, 3, 4]) {
        script.journey = { ...RESTORING, at }
        shot(script, null)
      }
      script.model = { ...script.model, status: 'running' }
      script.journey = { ...RESTORING, at: 4, ended: true, result: LANDED.restore }
      // backups/page.tsx
      shot(
        script,
        'Who can join stays as it is now: bans, operators and the whitelist are put back after the restore.',
      )
      trim(script, shelf, safetyKept)
      return script.frames
    }
    case 'delete': {
      const script = open({ ...model, status: 'deleted', trashLeft: shelf.trashDays })
      // The delete dialog's own words. apps/web/src/app/(app)/servers/[id]/settings/page.tsx
      shot(
        script,
        `The server stops and its address stops working. It waits in your trash, where you can restore it for ${shelf.trashDays} days; then it is gone for good.`,
      )
      return script.frames
    }
    case 'wait': {
      const left = model.trashLeft - 1
      if (left > 0) {
        const script = open({ ...model, day, trashLeft: left })
        shot(script, `Day ${day}. Still in the trash, with its world and its backups: ${daysOf(left)} left.`)
        return script.frames
      }
      // Past its date a server is purged, and its backups with it; only downloads outlive it.
      // apps/control/src/app/operations/handlers.ts
      const script = open({ ...model, day, trashLeft: 0, status: 'purged', backups: [] })
      shot(
        script,
        `Day ${day}. Its days in the trash are over: the server, its world and the backups on this shelf are gone for good. Only a download made of the world would be left, for as long as downloads are kept.`,
      )
      return script.frames
    }
    case 'undelete': {
      // Back stopped, at its own address, which was held for it meanwhile.
      // apps/control/src/domain/server/lifecycle.ts, apps/control/src/app/servers/persistence.ts
      const script = open({ ...model, status: 'stopped', trashLeft: 0 })
      shot(script, 'It is back from the trash with its world and its backups, asleep, at the address it had.')
      return script.frames
    }
  }
}

/** Another plan's shelf over the same backups. The older ones go when the shelf is next trimmed. */
function switched(model: Model, shelf: Shelf): Frame {
  const crowded = mine(model.backups).length > shelf.kept
  return {
    ...OPENING,
    model,
    lines: [
      `On ${shelf.said} the shelf keeps the newest ${shelf.kept}, and a deleted server waits ${shelf.trashDays} days in the trash.${
        crowded ? ' The older backups here leave when the next one is taken.' : ''
      }`,
    ],
  }
}

interface State {
  plan: number
  frames: readonly Frame[]
  /** Which moment of the run is showing. */
  at: number
  /** The last thing that happened to the server, whoever pressed it; null until something has. */
  did: Act | null
}

type Action =
  | { type: 'plan'; plan: number; shelf: Shelf }
  /** `still`: the viewer asked for less motion, so the run arrives at its end at once. */
  | { type: 'act'; act: Act; shelf: Shelf; safetyKept: number; still: boolean }
  | { type: 'tick' }

function reduce(state: State, action: Action): State {
  const last = state.frames.length - 1
  const now = state.frames[state.at]
  switch (action.type) {
    case 'tick':
      return state.at < last ? { ...state, at: state.at + 1 } : state
    case 'plan':
      if (state.at < last || now === undefined || action.plan === state.plan) return state
      return { ...state, plan: action.plan, frames: [switched(now.model, action.shelf)], at: 0 }
    case 'act': {
      if (state.at < last || now === undefined) return state
      const frames =
        action.act === 'again' ? [OPENING] : play(action.act, now.model, action.shelf, action.safetyKept)
      if (frames.length === 0) return state
      return { ...state, frames, at: action.still ? frames.length - 1 : 0, did: action.act }
    }
  }
}

// ─── Left alone, it plays itself ─────────────────────────────────────────────────────────────

/** What the tour presses: each is a button the demonstration shows where the tour presses it. */
type Turn = Extract<Act, 'play' | 'backup' | 'break' | 'restore' | 'delete' | 'wait' | 'undelete' | 'again'>

/**
 * The tour's next press, which is the section's story a press at a time: a day of play leaves a
 * backup, a change that doesn't start goes back by itself, an older backup is restored, the server
 * is deleted, waits a day in the trash and is brought back. It follows from the last thing done,
 * whoever did it, and from where the server is now, so it carries on from wherever a person left
 * things, and it never chooses a button that is off.
 */
function following(did: Act | null, model: Model, shelf: Shelf): Turn {
  if (model.status === 'purged') return 'again'
  // One day in the trash shows it waiting. The tour never lets the last day run out: that is the
  // one thing here with no way back, and it is left for a person to press.
  if (model.status === 'deleted') return did === 'delete' && model.trashLeft > 1 ? 'wait' : 'undelete'
  switch (did) {
    case 'play':
      // On the newest Minecraft there is nothing to change to: the backup is taken by hand instead.
      return model.version < VERSIONS.length - 1 ? 'break' : 'backup'
    case 'backup':
    case 'change':
    case 'break':
      return offered(model.backups, shelf).length > 0 ? 'restore' : 'delete'
    case 'restore':
      return 'delete'
    default:
      return 'play'
  }
}

/** What the room's server is doing while nothing is being done to it, by its status. */
const STANDS: Partial<Record<Status, string>> = {
  running: 'on',
  stopped: 'asleep',
  deleted: 'trash',
  purged: 'gone',
}

/**
 * What the room in the chunk is told, so its scene can play this same server: a rack built from the
 * game's parts, with a chest for each backup on a bench beside it.
 *
 * `server` is what the rack is doing. A change or a restore still counts as on while its backup is
 * taken, because the server runs until then; after that it is restarting, and a change that hasn't
 * started is at fault until the server is back. `held` is true from the server being told to stop
 * writing until it is told to write again. `own` and `safety` are the chests on each shelf, `kept`
 * how many of the first the plan keeps, and `back` the shelf the world is coming back from.
 */
function roomOf({ model, told, journey, from }: Frame, kept: number) {
  const copying = told !== null && told < 4
  const failed = journey?.title === GOING_BACK.title && !journey.ended
  const source = model.backups.find((backup) => backup.id === from)
  return {
    server: STANDS[model.status] ?? (copying ? 'on' : failed ? 'fault' : 'restarting'),
    held: told !== null && told < 3,
    own: mine(model.backups).length,
    safety: safety(model.backups).length,
    kept,
    back: source === undefined ? 'none' : SAFETY.includes(source.why) ? 'safety' : 'own',
  }
}

/** What the tour's bar says is coming. A restore names the day it goes back to instead. */
const SOON: Record<Turn, string> = {
  play: 'A day of play',
  backup: 'A backup by hand',
  break: 'A change won’t start',
  restore: 'A backup is restored',
  delete: 'The server is deleted',
  wait: 'A day passes',
  undelete: 'It comes back',
  again: 'Back to the start',
}

/** How many days of play are drawn a square each, in two rows, before only the number says the rest. */
const PILE_MOST = 24

/** One thing that can happen to the server. Off, it stays in reach of the keyboard and does nothing. */
function Press({ off, onPress, children }: { off: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="bl-btn bl-btn--sm bl-btn--quiet"
      aria-disabled={off || undefined}
      onClick={off ? undefined : onPress}
    >
      {children}
    </button>
  )
}

/** One shelf: the backups of one kind, oldest on the left, and the room the plan has left. */
function Rack({
  label,
  list,
  keep,
  from,
  fresh,
}: {
  label: string
  list: readonly Backup[]
  keep: number
  from: number | null
  fresh: number | null
}) {
  // More than the plan keeps: the oldest are on their way off the left end.
  const over = Math.max(0, list.length - keep)
  const empty = Array.from({ length: Math.max(0, keep - list.length) }, (_, slot) => `empty-${slot}`)
  return (
    <div className={styles.rack}>
      <p className={`bl-small ${styles.rackLabel}`}>
        <span>{label}</span>
        <span className="bl-num">
          {list.length - over} of {keep} kept
        </span>
      </p>
      <ol className={styles.shelf}>
        {list.map((backup, index) => {
          const kind = index < over ? 'over' : backup.id === from ? 'open' : 'kept'
          return (
            <li key={backup.id} className={styles.slot}>
              <span
                className={
                  kind === 'kept' ? `bl-frame bl-frame--solid ${styles.cell}` : `bl-frame ${styles.cell}`
                }
                data-kind={kind}
                data-fresh={backup.id === fresh || undefined}
              >
                {kind === 'over' && <i className={`bl-dither ${styles.tint}`} data-level="3" aria-hidden />}
                <span className={styles.day}>Day {backup.day}</span>
                <span className={styles.reason}>{BADGE[backup.why]}</span>
                {kind === 'over' && <span className={styles.sr}>Leaving the shelf.</span>}
                {kind === 'open' && <span className={styles.sr}>The world came back from this one.</span>}
              </span>
            </li>
          )
        })}
        {empty.map((id) => (
          <li key={id} className={styles.slot} aria-hidden>
            <span className={`bl-frame ${styles.cell}`} data-kind="empty">
              <i className={`bl-dither ${styles.tint}`} data-level="1" />
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * What a moment says: its sentences, and the owner's steps where there is work to follow.
 *
 * While a run is going it is drawn twice: the moment showing, and under it, unseen, the run's last
 * moment, which is its tallest (`live` left out). The panel is then as tall at a run's first
 * sentence as at its last, so the page under it moves once a press and not once a sentence. That
 * matters now the demonstration presses its own buttons: nobody reading the end of the section is
 * shuffled about, and the page isn't measured again for every sentence.
 */
function After({ frame, live }: { frame: Frame; live?: 'off' | 'polite' }) {
  const { journey } = frame
  const unseen = live === undefined
  return (
    <div
      className={styles.after}
      data-two={journey === null ? undefined : ''}
      data-room={unseen || undefined}
      aria-hidden={unseen || undefined}
    >
      <div className={styles.said} aria-live={live}>
        {frame.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {journey !== null && (
        <div className={`bl-frame bl-frame--bare ${styles.journey}`}>
          <p className={styles.title}>{journey.title}</p>
          <ol className={styles.steps}>
            {journey.steps.map((step, index) => {
              const at = journey.ended || index < journey.at ? 'done' : index === journey.at ? 'now' : 'todo'
              return (
                <li
                  key={step}
                  className={styles.step}
                  data-state={at}
                  aria-current={at === 'now' ? 'step' : undefined}
                >
                  <span className={styles.mark} aria-hidden>
                    {at === 'todo' && <i className="bl-dither" data-level="3" />}
                  </span>
                  <span className={styles.words}>{step}</span>
                </li>
              )
            })}
          </ol>
          {journey.result !== null && <p className={styles.result}>{journey.result}</p>}
        </div>
      )}
    </div>
  )
}

export function BackupsDemo({
  shelves,
  safetyKept,
  commands,
}: {
  shelves: readonly Shelf[]
  /** How many safety backups are kept, on every plan. */
  safetyKept: number
  /** What a running server is told before the copy, twice, and after it. */
  commands: readonly [string, string, string]
}) {
  const root = useRef<HTMLDivElement>(null)
  const inView = useInView(root)
  const still = useReducedMotion()
  const [state, dispatch] = useReducer(reduce, { plan: 0, frames: [OPENING], at: 0, did: null })

  const frame = state.frames[state.at] ?? OPENING
  const running = state.at < state.frames.length - 1
  // Where the run going now will come to rest.
  const ending = state.frames[state.frames.length - 1]
  const { model, hold } = frame
  const inTrash = model.status === 'deleted'
  const gone = model.status === 'purged'

  const shelf = shelves[state.plan] ?? shelves[0]
  const acts = useRef<HTMLDivElement>(null)
  // The last press, for where the keyboard goes further down: whether it was the tour's own, and
  // whether the keyboard was resting on one of these buttons, which the press may take away.
  const pressed = useRef({ byTour: false, held: false })
  const act = (kind: Act, byTour = false) => {
    if (shelf === undefined) return
    pressed.current = { byTour, held: acts.current?.contains(document.activeElement) ?? false }
    dispatch({ type: 'act', act: kind, shelf, safetyKept, still })
  }

  // Left alone, it plays itself: one press of its own each time the bar runs out. The bar runs for
  // as long as the run the last press started, and then a while on where that came to rest, so a
  // press of the tour's never lands on a run still going (the reducer would only ignore it). The
  // first wait is the short one only while nothing has been pressed, for the same reason.
  //
  // What comes next is read from where the run comes to rest, because that is where the press
  // lands. Read from the moment showing, the bar could name one day to go back to and then, once
  // the run had shelved a backup and pushed the oldest off, another.
  const resting = (ending ?? frame).model
  const coming = shelf === undefined ? null : following(state.did, resting, shelf)
  const runMs = state.frames.slice(0, -1).reduce((ms, moment) => ms + moment.hold, 0)
  const seconds = Math.min(BAR_MOST_S, runMs / 1000 + LINGER_S)
  const tour = useTour({
    ref: root,
    steps: coming === null ? [] : [() => act(coming, true)],
    seconds,
    first: state.did === null ? 3 : seconds,
  })

  // Simulated time: each moment is held, then the next arrives. Only while it can be seen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each moment starts its own wait, though two may hold as long
  useEffect(() => {
    if (!running || !inView) return
    const timer = setTimeout(() => dispatch({ type: 'tick' }), hold)
    return () => clearTimeout(timer)
  }, [running, inView, state.at, hold])

  // The room in the chunk: its lamps on while something is being done to the server, out while it
  // is in the trash, and otherwise left to the page.
  const dark = inTrash || gone
  useEffect(() => {
    stage.glow('backups', !inView ? null : dark ? 0 : running ? 1 : null)
  }, [inView, dark, running])
  // The room's scene plays the moment showing: the copy goes into a chest there as it is shelved
  // here, and the world comes back out of one as it does here. Out of sight nothing here moves, so
  // the room is left to play by itself.
  const kept = shelf?.kept ?? 0
  useEffect(() => {
    stage.show('backups', inView ? roomOf(frame, kept) : null)
  }, [inView, frame, kept])
  useEffect(
    () => () => {
      stage.glow('backups', null)
      stage.show('backups', null)
    },
    [],
  )

  // Deleting it, bringing it back and losing it each swap the buttons, and one the keyboard rested
  // on is gone with the rest: the keyboard goes to the first of the new ones rather than nowhere.
  // When the tour swaps them, that is only where the keyboard already rested on one of them, so
  // the keys aren't taken from someone only scrolling; and the page isn't pulled to the button,
  // which may be off the screen by then. A person's own press is where they are looking.
  const place = gone ? 'gone' : inTrash ? 'trash' : 'live'
  const placed = useRef(place)
  useEffect(() => {
    if (placed.current === place) return
    placed.current = place
    const { byTour, held } = pressed.current
    if (byTour && !held) return
    const now = document.activeElement
    if (now === null || now === document.body)
      acts.current?.querySelector('button')?.focus({ preventScroll: byTour })
  }, [place])

  if (shelf === undefined) return null

  const version = VERSIONS[model.version] ?? VERSIONS[0]
  const newest = model.version >= VERSIONS.length - 1
  // The oldest backup offered now, which the Restore button needs, and the one the tour's restore
  // will go back to: the oldest offered once the run going now has come to rest.
  const oldest = offered(model.backups, shelf)[0]
  const back = offered(resting.backups, shelf)[0]
  const [off, flush, on] = commands
  const told = [
    { id: 'off', text: off, real: true },
    { id: 'flush', text: flush, real: true },
    { id: 'copy', text: COPY, real: false },
    { id: 'on', text: on, real: true },
  ]
  const pile = Array.from({ length: Math.min(model.holds.length, PILE_MOST) }, (_, block) => `built-${block}`)
  const soon =
    coming === null
      ? undefined
      : coming === 'restore' && back !== undefined
        ? `Back to day ${back.day}`
        : SOON[coming]

  return (
    <div className={styles.demo} ref={root}>
      <TourBar tour={tour} label={soon} className={styles.tour} />
      <div>
        {shelves.length > 1 && (
          <fieldset className={styles.ask}>
            <legend className={styles.q}>The plan it is on</legend>
            <div className={styles.chips}>
              {shelves.map((option, index) => (
                <button
                  key={option.key}
                  type="button"
                  className="bl-chip"
                  aria-pressed={index === state.plan}
                  aria-disabled={running || undefined}
                  onClick={running ? undefined : () => dispatch({ type: 'plan', plan: index, shelf: option })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        )}
      </div>

      <div className={`bl-frame bl-frame--bare ${styles.server}`}>
        <div className={styles.head}>
          <div className={styles.who}>
            <p className={styles.name}>{NAME}</p>
            <span className={`bl-game ${styles.address}`} data-off={inTrash || gone || undefined}>
              {ADDRESS}
            </span>
            {(inTrash || gone) && <span className={styles.sr}>Its address has stopped working.</span>}
          </div>
          <p className={styles.status}>
            <i className={styles.lamp} data-on={model.status === 'running' || undefined} aria-hidden />
            <span>{SAYS[model.status]}</span>
            <span className={`bl-mono ${styles.code}`}>
              <span className={styles.sr}>Its status is </span>
              {model.status}
            </span>
          </p>
        </div>
        <dl className={styles.stats}>
          <div>
            <dt className="bl-small">Day</dt>
            <dd className="bl-num">{model.day}</dd>
          </div>
          {!gone && (
            <div>
              <dt className="bl-small">Minecraft</dt>
              <dd className={`bl-mono ${styles.version}`}>{version}</dd>
            </div>
          )}
          {!gone && (
            <div>
              <dt className="bl-small">In its world</dt>
              <dd className={styles.world}>
                <span className="bl-num">{daysOf(model.holds.length)} of play</span>
                <span className={styles.pile} aria-hidden>
                  {pile.map((id) => (
                    <i key={id} />
                  ))}
                </span>
              </dd>
            </div>
          )}
          {inTrash && (
            <div>
              <dt className="bl-small">Gone for good in</dt>
              <dd className="bl-num">{daysOf(model.trashLeft)}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className={styles.racks}>
        <Rack
          label="Daily, and any you take yourself"
          list={mine(model.backups)}
          keep={shelf.kept}
          from={frame.from}
          fresh={frame.fresh}
        />
        <Rack
          label="From before a change, a restore or a move"
          list={safety(model.backups)}
          keep={safetyKept}
          from={frame.from}
          fresh={frame.fresh}
        />
      </div>

      <div className={styles.told}>
        <p className="bl-small">What a running server is told around the copy</p>
        <ol className={styles.cmds}>
          {told.map((thing, index) => (
            <li
              key={thing.id}
              className={styles.cmd}
              data-state={
                frame.told === null || index > frame.told ? 'idle' : index === frame.told ? 'now' : 'done'
              }
            >
              <span className={thing.real ? 'bl-mono' : undefined}>{thing.text}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className={styles.acts} ref={acts}>
        {gone ? (
          <fieldset className={styles.ask}>
            <legend className={styles.q}>Nothing is left to bring back</legend>
            <div className={styles.btns}>
              <Press off={running} onPress={() => act('again')}>
                Start the example again
              </Press>
            </div>
          </fieldset>
        ) : inTrash ? (
          <fieldset className={styles.ask}>
            <legend className={styles.q}>While it is in the trash</legend>
            <div className={styles.btns}>
              <Press off={running} onPress={() => act('undelete')}>
                Bring it back
              </Press>
              <Press off={running} onPress={() => act('wait')}>
                A day passes
              </Press>
            </div>
          </fieldset>
        ) : (
          <>
            <fieldset className={styles.ask}>
              <legend className={styles.q}>A day goes by</legend>
              <div className={styles.btns}>
                <Press off={running} onPress={() => act('play')}>
                  A day of play
                </Press>
                <Press off={running} onPress={() => act('quiet')}>
                  A day nobody plays
                </Press>
              </div>
            </fieldset>
            <fieldset className={styles.ask}>
              <legend className={styles.q}>Its owner, while friends are on</legend>
              <div className={styles.btns}>
                <Press off={running} onPress={() => act('backup')}>
                  Back up now
                </Press>
                <Press off={running || newest} onPress={() => act('change')}>
                  Change the Minecraft version
                </Press>
                <Press off={running || newest} onPress={() => act('break')}>
                  A change that doesn’t start
                </Press>
                <Press off={running || oldest === undefined} onPress={() => act('restore')}>
                  Restore an older backup
                </Press>
                <Press off={running} onPress={() => act('delete')}>
                  Delete the server
                </Press>
              </div>
              {newest && (
                <p className={`bl-small ${styles.hint}`}>
                  It runs the newest Minecraft there is to choose, so there is no version left to change to.
                </p>
              )}
            </fieldset>
          </>
        )}
      </div>

      <div className={styles.outcome}>
        {running && ending !== undefined && <After frame={ending} />}
        {/* While the tour is what presses, a screen reader isn't read every moment of it. */}
        <After frame={frame} live={tour.auto ? 'off' : 'polite'} />
      </div>
    </div>
  )
}
