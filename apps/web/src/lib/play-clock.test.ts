// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { countedFrom, zoneFrom, zoneSaid } from './play-clock'

describe('the play clock on the account page', () => {
  test('says a time zone as people say it, fixed offsets the right way round', () => {
    expect(zoneSaid('America/New_York')).toBe('New York time')
    expect(zoneSaid('UTC')).toBe('UTC')
    expect(zoneSaid('Etc/UTC')).toBe('UTC')
    expect(zoneSaid('Etc/GMT')).toBe('UTC')
    expect(zoneSaid('Etc/GMT-12')).toBe('UTC+12')
    expect(zoneSaid('Etc/GMT+5')).toBe('UTC-5')
  })

  test('says when this month counts from only when it began later in this month', () => {
    const now = new Date('2026-10-20T12:00:00Z')
    expect(countedFrom('2026-10-17T09:30:00Z', 'UTC', now)).toBe('This month counts from 17 October. ')
    expect(countedFrom('2026-10-01T00:00:00Z', 'UTC', now)).toBe('')
    // A month a zone behind took over in began on the last day of the month before, by its clock.
    expect(countedFrom('2026-11-30T10:00:00Z', 'UTC', new Date('2026-12-05T00:00:00Z'))).toBe('')
  })

  test('says when a waiting zone takes over, for the month and for the day', () => {
    const next = { zone: 'America/New_York', from: '2026-11-01T04:00:00Z' }
    expect(zoneFrom(next, 'month')).toBe(
      'Your hours reset at midnight on the 1st, New York time, from 1 November. ',
    )
    expect(zoneFrom(next, 'day')).toBe('Your day resets at midnight, New York time, from 1 November. ')
    expect(zoneFrom({ zone: 'Etc/UTC', from: '2026-12-01T00:00:00Z' }, 'day')).toBe(
      'Your day resets at midnight, UTC, from 1 December. ',
    )
    expect(zoneFrom(null, 'month')).toBe('')
  })
})
