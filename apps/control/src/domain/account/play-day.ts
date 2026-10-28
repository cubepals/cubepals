// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The month a plan's monthly block is counted over: from the owner's local midnight on the 1st to
 * the next 1st, in the time zone their browser reported, or UTC until one has. A zone reported
 * later takes over once the month has begun again in both, and the month it takes over in runs
 * from when it began in the zone before. Only the clock lives here; what was played in it is
 * `accounts/play-month.ts`'s.
 */
import { SECOND_MS } from '@blockly/contracts/durations'

/** Where a month is counted until the owner's browser has said where they are. */
export const DEFAULT_TIME_ZONE = 'UTC'

/** Whether `zone` is a time zone this runtime knows, as a browser reports one ("Europe/Paris"). */
export function isTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const formats = new Map<string, Intl.DateTimeFormat>()

/** The wall clock in `zone` at `at`, as the fields of a UTC date that reads the same. */
function wallClock(at: Date, zone: string): { year: number; month: number; day: number; ms: number } {
  let format = formats.get(zone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formats.set(zone, format)
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(format.formatToParts(at).find((p) => p.type === type)?.value ?? 0)
  const [year, month, day] = [part('year'), part('month'), part('day')]
  const ms = Date.UTC(year, month - 1, day, part('hour'), part('minute'), part('second'))
  return { year, month, day, ms }
}

/** How far `zone` is ahead of UTC at `at`, in milliseconds. */
const offsetAt = (at: Date, zone: string): number =>
  wallClock(at, zone).ms - Math.floor(at.getTime() / SECOND_MS) * SECOND_MS

/**
 * The moment a local date begins in `zone`. Asked twice, so a clock change between UTC midnight
 * and local midnight is accounted for; where a clock change skips midnight itself, the day begins
 * at the first moment it has.
 */
function midnightOf(year: number, month: number, day: number, zone: string): Date {
  const utc = Date.UTC(year, month - 1, day)
  const first = utc - offsetAt(new Date(utc), zone)
  return new Date(utc - offsetAt(new Date(first), zone))
}

/** When the local month `at` falls in began, in `zone`: midnight on its 1st. */
export function monthStart(at: Date, zone: string): Date {
  const { year, month } = wallClock(at, zone)
  const start = midnightOf(year, month, 1, zone)
  // A midnight a clock change moved can land a moment after `at`; the month began by `at`.
  return start.getTime() > at.getTime() ? at : start
}

/** When the next local month begins after `at`, in `zone`: when a monthly block starts again. */
export function nextMonthStart(at: Date, zone: string): Date {
  const { year, month } = wallClock(at, zone)
  return midnightOf(year, month + 1, 1, zone)
}

/**
 * Where the zone in force took over from the one before (`AccountStanding.timeZoneFrom`), and when
 * the month it took over in began, in the zone before (`timeZoneBegan`).
 */
export interface ZoneChange {
  from: Date
  began: Date
}

/**
 * When a zone reported at `now` takes over from `zone`: once the month after the one `zone` is
 * counting has begun in both, so this month is counted in `zone` to its end, the month the new zone
 * takes over in is the same month in either, and no hours open early.
 */
export function zoneTakesOver(now: Date, zone: string, next: string): Date {
  const after = nextMonthStart(now, zone)
  return new Date(Math.max(after.getTime(), startOfMonth(monthOf(after, zone), next).getTime()))
}

/**
 * When the month `at` falls in began, in `zone`: midnight on its 1st, except the month a zone took
 * over in, which began when it did in the zone before.
 */
export function monthBegan(at: Date, zone: string, change: ZoneChange | null): Date {
  const start = monthStart(at, zone)
  return change !== null && start.getTime() === monthStart(change.from, zone).getTime() ? change.began : start
}

/** The local month `at` falls in, in `zone`, as the date of its 1st: "2026-10-01". */
export function monthOf(at: Date, zone: string): string {
  const { year, month } = wallClock(at, zone)
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/** When the month `monthOf` names began, in `zone`. */
export function startOfMonth(month: string, zone: string): Date {
  const [year, number] = month.split('-').map(Number)
  return midnightOf(year ?? 1970, number ?? 1, 1, zone)
}
