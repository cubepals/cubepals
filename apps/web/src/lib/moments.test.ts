// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { noticed, whenOf } from './moments'

describe('the good-moment question', () => {
  // A Wednesday, at noon where the test runs.
  const now = new Date(2026, 9, 7, 12)

  test('says when as a person would', () => {
    expect(whenOf(new Date(2026, 9, 7, 9), now)).toBe('today')
    expect(whenOf(new Date(2026, 9, 6, 23), now)).toBe('yesterday')
    expect(whenOf(new Date(2026, 9, 4, 18), now)).toBe('on Sunday')
    expect(whenOf(new Date(2026, 8, 28, 18), now)).toBe('on September 28')
  })

  test('names what it noticed', () => {
    const at = new Date(2026, 9, 4, 18).toISOString()
    expect(
      noticed({ moment: 'moment_first_friend_joined', at, serverName: 'Castle', player: 'Alex' }, now),
    ).toBe('Alex joined Castle on Sunday.')
    expect(noticed({ moment: 'moment_first_wake', at, serverName: 'Castle', player: null }, now)).toBe(
      'Castle woke for a player on Sunday.',
    )
    expect(noticed({ moment: 'moment_first_week', at, serverName: 'Castle', player: null }, now)).toBe(
      'Castle has had a second week of play.',
    )
  })
})
