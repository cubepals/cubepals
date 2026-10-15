// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Today's play, on a plan that counts it by the day (`Entitlements.dailyUnits`): what the owner's
 * servers ran since their local midnight, in meter units, and when the next day brings it back. A
 * run that crosses midnight counts toward the day each part of it fell in, and the free play of
 * accounts that share this one's (`free-play.ts`) counts as this account's own. The clock is
 * `domain/account/play-day.ts`'s; stopping a run when the day's play is used is the session check's.
 */
import type { ServerView } from '@blockly/contracts'
import { DAY_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { type Queryable, schema } from '@blockly/db'
import { and, eq, gt, isNull, max, sql } from 'drizzle-orm'
import type { Entitlements } from '../../domain/account/entitlements.ts'
import { METER_UNITS } from '../../domain/account/meter.ts'
import { DEFAULT_TIME_ZONE, dayStart, nextDayStart } from '../../domain/account/play-day.ts'
import type { AccountStanding } from '../../domain/account/standing.ts'
import type { MemoryTier } from '../../domain/server/size.ts'
import { freeSharers } from './free-play.ts'
import { runUnitsSince } from './persistence.ts'

export interface PlayToday {
  /** The plan's daily block, in units. */
  included: number
  /** Played since the owner's midnight, open runs counted up to now. */
  units: number
  /** Units left today; zero once they are used. */
  left: number
  /** When the owner's next day begins, and its play with it. */
  backAt: Date
}

/** Today's play for the account; null when its plan counts none by the day. */
export async function playToday(
  q: Queryable,
  standing: Pick<AccountStanding, 'userId' | 'timeZone'>,
  plan: Pick<Entitlements, 'dailyUnits'>,
  now: Date,
): Promise<PlayToday | null> {
  if (plan.dailyUnits === null) return null
  const zone = standing.timeZone ?? DEFAULT_TIME_ZONE
  const { ids } = await freeSharers(q, standing.userId, now)
  const units = await runUnitsSince(q, ids, dayStart(now, zone), now)
  return {
    included: plan.dailyUnits,
    units,
    left: Math.max(0, plan.dailyUnits - units),
    backAt: nextDayStart(now, zone),
  }
}

/**
 * Minutes until running at `rate` units an hour uses today's play up. Where today's lasts past
 * midnight, the run goes on into the next day's, so the end is that day's block after midnight.
 */
export function minutesOfPlayLeft(today: PlayToday, rate: number, now: Date): number {
  const left = (today.left / rate) * 60
  const toMidnight = (today.backAt.getTime() - now.getTime()) / MINUTE_MS
  return left < toMidnight ? left : toMidnight + (today.included / rate) * 60
}

/** Today's play as the server page reads it: hours on this server's size, which may count double. */
export const todayView = (today: PlayToday | null, tier: MemoryTier): ServerView['playToday'] =>
  today === null
    ? null
    : {
        hours: today.included,
        hoursLeft: Math.floor((today.left / METER_UNITS[tier]) * 100) / 100,
        backAt: today.backAt.toISOString(),
      }

/**
 * Each live server stopped because its owner's day of play ran out, with its owner's time zone and
 * when it stopped, as `outOf` reads them; unrun, so the edge's routes can fold it into their
 * fingerprint (`edge/inputs.ts`). A day is at most 26 hours, so a stop longer ago than two days,
 * by the database's clock, is past its midnight and left out.
 */
export function dailyStops(q: Queryable) {
  const servers = schema.minecraftServers
  const intervals = schema.powerIntervals
  const standing = schema.accountStanding
  return q
    .select({ id: servers.id, zone: standing.timeZone, stoppedAt: max(intervals.stoppedAt) })
    .from(servers)
    .innerJoin(intervals, eq(intervals.serverId, servers.id))
    .leftJoin(standing, eq(standing.userId, servers.ownerId))
    .where(
      and(
        isNull(servers.deletedAt),
        eq(servers.status, 'stopped'),
        eq(servers.stopReason, 'daily'),
        gt(intervals.stoppedAt, sql`now() - make_interval(secs => ${(2 * DAY_MS) / SECOND_MS})`),
      ),
    )
    .groupBy(servers.id, standing.timeZone)
}

/**
 * Of `dailyStops`, the servers still asleep for the day at `now`, with when they are back: the next
 * local midnight after the stop, while that is still to come.
 */
export function outOf(
  stops: ReadonlyArray<{ id: string; zone: string | null; stoppedAt: Date | null }>,
  now: Date,
): Map<string, Date> {
  const out = new Map<string, Date>()
  for (const row of stops) {
    if (row.stoppedAt === null) continue
    const backAt = nextDayStart(row.stoppedAt, row.zone ?? DEFAULT_TIME_ZONE)
    if (backAt > now) out.set(row.id, backAt)
  }
  return out
}
