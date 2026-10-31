// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When a running server nobody is on goes to sleep: the one rule the idle check stops servers by
 * (`app/operations/schedules/idle.ts`) and the server page says ahead of time ("Sleeps at 14:32 if
 * nobody joins"), so the two can't disagree. Reading the run, the players and the plan is the
 * callers'; this only decides.
 */

import { MINUTE_MS } from '@blockly/contracts/durations'

/**
 * How long a run that a connection woke has to see somebody actually join (§15.1). A forged
 * login costs one connection and would otherwise buy a whole idle window of billed compute —
 * ten minutes on free, fifteen on Plus.
 *
 * Five minutes, not two, and the reason is what a real join looks like: a world that takes
 * longer to load than the edge will hold the connection open gets dropped mid-wake, and the
 * player tries again. A smoke run caught exactly that — woken at 11:26, the connection closed
 * at 11:27 while it was still loading, and the probation stopped it at 11:29, before anyone
 * could come back. The window has to cover somebody noticing and clicking Join a second time.
 * It still cuts an abusive wake from ten minutes to five on free, and from fifteen to five on
 * Plus, and nothing about it can be forged: only a login that completes ends the probation. On a
 * server whose owner turned off account checks, completing one takes no account, only a name the
 * server lets in.
 */
export const WAKE_PROBATION_MS = 5 * MINUTE_MS

/** When an empty running server is due to sleep, and which rule says so. */
export interface Bedtime {
  at: Date
  /** `nobody_joined`: a connection woke it and nobody has joined since. `idle`: the plan's idle time. */
  why: 'nobody_joined' | 'idle'
}

/**
 * When a running server with nobody on it goes to sleep, or null when its plan never sleeps it.
 *
 * Its plan's idle time counts from whichever came last: somebody playing, or the server becoming
 * running. A world woken from its page gets the whole window from the moment it is running, however
 * long ago anyone last played it, and however long its wake took; one woken by a connection that
 * nobody followed gets only the probation. A change or a restore that takes it down and back stays
 * in the same run, since its usage goes on counting through it, but nobody could join while it was
 * down: either window counts again from when it is running again.
 */
export function bedtime(
  run: {
    startedAt: Date
    /** When it last became running; null where that isn't known, and the run's start stands. */
    readyAt: Date | null
    woken: boolean
  } | null,
  /** When somebody was last seen on it, in this run or any before it. */
  played: Date | null,
  /** The plan's idle time; null when it never sleeps an idle server. */
  idleMinutes: number | null,
): Bedtime | null {
  const playedThisRun = played !== null && (run === null || played >= run.startedAt)
  const up = run === null ? null : later(run.startedAt, run.readyAt)
  if (up !== null && run?.woken && !playedThisRun)
    return { at: new Date(up.getTime() + WAKE_PROBATION_MS), why: 'nobody_joined' }
  if (idleMinutes === null) return null
  const since = up === null ? played : later(up, playedThisRun ? played : null)
  if (since === null) return null
  return { at: new Date(since.getTime() + idleMinutes * MINUTE_MS), why: 'idle' }
}

/** The later of two moments, where the second may be missing. */
function later(a: Date, b: Date | null): Date {
  return b !== null && b > a ? b : a
}

/**
 * The idle time an empty server gets now: its plan's, but no longer than `tightMinutes` for a
 * server on a free plan while room is tight, so the room goes to people who want to play. Never
 * shortened on a paid plan; and a server anyone is on doesn't idle at all.
 */
export function idleMinutesNow(
  planMinutes: number | null,
  room: { free: boolean; tight: boolean; tightMinutes: number },
): number | null {
  if (!room.free || !room.tight) return planMinutes
  return planMinutes === null ? room.tightMinutes : Math.min(planMinutes, room.tightMinutes)
}
