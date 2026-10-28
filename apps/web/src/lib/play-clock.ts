// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When the account page says a plan's month begins: from when this month's hours count, when that
 * wasn't the 1st, and the time zone a reported change brings, from when. Only the sentences live
 * here; the clock itself is the control plane's (`domain/account/play-day.ts`).
 */

/** A day as the page says it, in `zone`: "1 December". */
const dayIn = (at: string, zone: string) =>
  new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: zone })

/** The year and month `at` falls in, in `zone`: "2026-10". */
const monthIn = (at: Date, zone: string) =>
  at.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', timeZone: zone })

/** Zones that are UTC itself, under any of their names. */
const UTC_NAMES = /^(Etc\/)?(UTC|UCT|GMT|GMT[+-]?0|Greenwich|Universal|Zulu)$/

/**
 * A time zone as people say it: "New York time", "UTC". The `Etc/GMT` zones carry their sign the
 * POSIX way round, so `Etc/GMT-12` is twelve hours ahead: "UTC+12".
 */
export function zoneSaid(zone: string): string {
  if (UTC_NAMES.test(zone)) return 'UTC'
  const fixed = /^Etc\/GMT([+-])(\d{1,2})$/.exec(zone)
  if (fixed !== null) return `UTC${fixed[1] === '+' ? '-' : '+'}${fixed[2]}`
  return `${(zone.split('/').at(-1) ?? zone).replaceAll('_', ' ')} time`
}

/**
 * When this month's hours started counting, said only when that was later in this month than its
 * 1st, as in the month a plan began. A month a new zone took over in can begin on the last day of
 * the month before, by that zone's clock; that is never said.
 */
export function countedFrom(monthBegan: string, zone: string, now: Date): string {
  const began = new Date(monthBegan)
  const day = dayIn(monthBegan, zone)
  return monthIn(began, zone) === monthIn(now, zone) && !day.startsWith('1 ')
    ? `This month counts from ${day}. `
    : ''
}

/**
 * A time zone waiting to take over, as a sentence: that the month's hours reset at its midnight on
 * the 1st, and from when. Nothing when none waits, or when the control plane answering is older
 * and doesn't say.
 */
export function zoneFrom(next: { zone: string; from: string } | null | undefined): string {
  if (next === null || next === undefined) return ''
  return `Your hours reset at midnight on the 1st, ${zoneSaid(next.zone)}, from ${dayIn(next.from, next.zone)}. `
}
