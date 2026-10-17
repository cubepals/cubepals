// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An account's standing as admins and its owner set it: active, suspended or closed, its plan and
 * restrictions, an admin's limits, and the owner's own choices (extra play, the AFK kick), with
 * which warnings about the month's play were sent, and the time zone its day is counted in.
 */
import type { ZoneChange } from './play-day.ts'

type AccountStatus = 'active' | 'suspended' | 'terminated'

export interface Restrictions {
  provisioning?: boolean
  publicListing?: boolean
  consoleCommands?: boolean
}

export interface AccountStanding {
  userId: string
  status: AccountStatus
  reason: string | null
  plan: string
  restrictions: Restrictions
  limitOverrides: {
    maxServers?: number
    maxRunning?: number
    includedUnits?: number
    carryUnits?: number
    maxSessionMinutes?: number
    idleShutdownAfterMinutes?: number
  }
  /**
   * Play past the plan's included block that the owner has allowed, in meter units. Zero means
   * servers sleep when the block runs out, which is where every account starts: money is the
   * owner's decision, and Blockly never makes it for them.
   */
  extraUnitsAllowed: number
  /**
   * The AFK kick the owner set, in minutes; null leaves the plan's own, and 0 is never. On a plan
   * where play is metered, someone standing still in a loaded chunk spends the owner's money, so
   * it is theirs to set rather than Blockly's to decide — and never kicking, the costliest, is
   * only ever their choice, never a default.
   */
  afkKickMinutes: number | null
  /** The last play warning sent, as `YYYY-MM:percent`; null before any. */
  playWarned: string | null
  /** The last extra-play email sent, as `YYYY-MM:mark` (0, 80 or 100); null before any. */
  extraWarned: string | null
  /**
   * Where the owner is, as their browser last reported it ("Europe/Paris"): where a plan's day
   * begins (`play-day.ts`). Null until it has, and the day is UTC's.
   */
  timeZone: string | null
  /**
   * When `timeZone` took over from the zone before, and when the month and day it took over in
   * began (`play-day.ts` `ZoneChange`); null when it has been the zone from the start.
   */
  timeZoneFrom: Date | null
  timeZoneBegan: Date | null
  /**
   * A zone the browser reported since, and when it takes over (`zoneTakesOver`): the month is
   * counted in one zone from its start to its end. Null when none waits.
   */
  nextTimeZone: string | null
  nextTimeZoneFrom: Date | null
  /** Cubepals' own, for testing it: never billed, and left out of its numbers and analytics. */
  testAccount: boolean
}

export function newStanding(userId: string): AccountStanding {
  return {
    userId,
    status: 'active',
    reason: null,
    plan: 'free',
    restrictions: {},
    limitOverrides: {},
    extraUnitsAllowed: 0,
    afkKickMinutes: null,
    playWarned: null,
    extraWarned: null,
    timeZone: null,
    timeZoneFrom: null,
    timeZoneBegan: null,
    nextTimeZone: null,
    nextTimeZoneFrom: null,
    testAccount: false,
  }
}

/** Where the account's zone in force took over from the one before; null when it always was. */
export function zoneChange(
  standing: Pick<AccountStanding, 'timeZoneFrom' | 'timeZoneBegan'>,
): ZoneChange | null {
  return standing.timeZoneFrom === null || standing.timeZoneBegan === null
    ? null
    : { from: standing.timeZoneFrom, began: standing.timeZoneBegan }
}
