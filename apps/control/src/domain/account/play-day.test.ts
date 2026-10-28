// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The play month: where it begins, in the owner's time zone. */
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TIME_ZONE,
  isTimeZone,
  monthBegan,
  monthOf,
  monthStart,
  nextMonthStart,
  startOfMonth,
  zoneTakesOver,
} from './play-day.ts'

const at = (iso: string) => new Date(iso)

describe('the owner’s time zone', () => {
  test('is UTC until the owner’s browser says where they are', () => {
    expect(DEFAULT_TIME_ZONE).toBe('UTC')
    expect(monthStart(at('2026-10-12T15:30:00Z'), DEFAULT_TIME_ZONE)).toEqual(at('2026-10-01T00:00:00Z'))
  })

  test('knows a real time zone from anything else', () => {
    expect(isTimeZone('Europe/Paris')).toBe(true)
    expect(isTimeZone('UTC')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
    expect(isTimeZone('')).toBe(false)
  })
})

describe('the play month', () => {
  test('begins at midnight on the 1st where the owner is', () => {
    expect(monthStart(at('2026-10-12T15:30:00Z'), 'UTC')).toEqual(at('2026-10-01T00:00:00Z'))
    expect(nextMonthStart(at('2026-10-12T15:30:00Z'), 'UTC')).toEqual(at('2026-11-01T00:00:00Z'))
    // 01:00 on 1 November in Tokyo (UTC+9) is still 31 October in UTC: November has begun there.
    expect(monthStart(at('2026-10-31T16:00:00Z'), 'Asia/Tokyo')).toEqual(at('2026-10-31T15:00:00Z'))
    expect(monthOf(at('2026-10-31T16:00:00Z'), 'Asia/Tokyo')).toBe('2026-11-01')
    expect(monthOf(at('2026-10-31T16:00:00Z'), 'UTC')).toBe('2026-10-01')
    // 20:00 on 31 October in Los Angeles (UTC-7) is 1 November in UTC: October goes on there.
    expect(monthStart(at('2026-11-01T03:00:00Z'), 'America/Los_Angeles')).toEqual(at('2026-10-01T07:00:00Z'))
    expect(nextMonthStart(at('2026-11-01T03:00:00Z'), 'America/Los_Angeles')).toEqual(
      at('2026-11-01T07:00:00Z'),
    )
  })

  test('crosses the year and a clock change, and is found again from its name', () => {
    expect(nextMonthStart(at('2026-12-15T00:00:00Z'), 'Europe/Paris')).toEqual(at('2026-12-31T23:00:00Z'))
    // Los Angeles moves to winter time on 1 November 2026, after midnight: the month begins on summer time.
    expect(startOfMonth('2026-11-01', 'America/Los_Angeles')).toEqual(at('2026-11-01T07:00:00Z'))
    expect(nextMonthStart(at('2026-11-15T00:00:00Z'), 'America/Los_Angeles')).toEqual(
      at('2026-12-01T08:00:00Z'),
    )
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Etc/GMT+12']) {
      const start = monthStart(at('2026-10-12T15:30:00Z'), zone)
      expect(startOfMonth(monthOf(start, zone), zone)).toEqual(start)
    }
  })
})

describe('a time zone that changes', () => {
  const kiritimati = 'Pacific/Kiritimati'

  test('takes over once the next month has begun in both zones, never sooner', () => {
    // Late on 30 November in UTC it is already 1 December in Kiritimati, UTC+14.
    const now = at('2026-11-30T12:00:00Z')
    expect(zoneTakesOver(now, 'UTC', kiritimati)).toEqual(at('2026-12-01T00:00:00Z'))
    // Kiritimati is counting December already: it counts it to its end, and UTC takes January.
    expect(zoneTakesOver(now, kiritimati, 'UTC')).toEqual(at('2027-01-01T00:00:00Z'))
    expect(zoneTakesOver(at('2026-11-10T00:00:00Z'), kiritimati, 'UTC')).toEqual(at('2026-12-01T00:00:00Z'))
    expect(zoneTakesOver(at('2026-11-10T00:00:00Z'), 'UTC', kiritimati)).toEqual(at('2026-12-01T00:00:00Z'))
  })

  test('to a zone ahead: its first month begins where the zone before left off', () => {
    const change = { from: at('2026-12-01T00:00:00Z'), began: at('2026-12-01T00:00:00Z') }
    // Kiritimati's December began 14 hours earlier, in the month UTC had already counted.
    expect(monthBegan(at('2026-12-01T05:00:00Z'), kiritimati, change)).toEqual(change.began)
    // From then on, the 1st is Kiritimati's.
    expect(monthBegan(at('2027-01-10T00:00:00Z'), kiritimati, change)).toEqual(at('2026-12-31T10:00:00Z'))
  })

  test('to a zone behind: its first month runs on from when it began in the zone before', () => {
    // Kiritimati's December began at 10:00 UTC on 30 November; UTC's begins 14 hours later.
    const change = { from: at('2026-12-01T00:00:00Z'), began: at('2026-11-30T10:00:00Z') }
    expect(monthBegan(at('2026-12-20T00:00:00Z'), 'UTC', change)).toEqual(change.began)
    expect(monthBegan(at('2027-01-10T00:00:00Z'), 'UTC', change)).toEqual(at('2027-01-01T00:00:00Z'))
  })

  test('changes nothing when there was no change', () => {
    const now = at('2026-10-12T15:30:00Z')
    expect(monthBegan(now, kiritimati, null)).toEqual(monthStart(now, kiritimati))
  })
})
