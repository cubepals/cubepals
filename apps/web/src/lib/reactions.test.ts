// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { ReactionsView } from '@blockly/contracts'
import { noted, shortCount, starred } from './reactions'

const view = (stars: number, on: boolean): ReactionsView => ({
  serverId: crypto.randomUUID(),
  stars,
  starred: on,
  notes: 3,
  yours: false,
})

describe('a star before the API answers', () => {
  test('starring counts one more, and unstarring one fewer', () => {
    expect(starred(view(12, false), true)).toMatchObject({ stars: 13, starred: true })
    expect(starred(view(12, true), false)).toMatchObject({ stars: 11, starred: false })
  })

  test('asking for the state it is already in changes nothing, so a double click cannot drift', () => {
    const on = view(12, true)
    expect(starred(on, true)).toBe(on)
    const off = view(12, false)
    expect(starred(off, false)).toBe(off)
    // A press and its undo land where they started.
    expect(starred(starred(off, true), false)).toEqual(off)
  })

  test('a count never drops below none', () => {
    // A stale count of none with the reader's own star still on, as a refetch can leave it.
    expect(starred(view(0, true), false)).toMatchObject({ stars: 0, starred: false })
  })

  test('only the star changes', () => {
    const before = view(4, false)
    const after = starred(before, true)
    expect(after).toMatchObject({ serverId: before.serverId, notes: 3, yours: false })
  })
})

describe('the notes count', () => {
  test('follows the total the API gave, and is the same view when nothing changed', () => {
    const before = view(0, false)
    expect(noted(before, 5).notes).toBe(5)
    expect(noted(before, 3)).toBe(before)
  })
})

describe('a count beside an icon', () => {
  test('stays a plain number while it is small, and shortens once it is not', () => {
    expect(shortCount(0)).toBe('0')
    expect(shortCount(12)).toBe('12')
    expect(shortCount(940)).toBe('940')
    expect(shortCount(1234).length).toBeLessThanOrEqual(5)
    expect(shortCount(1234)).not.toContain('234')
  })
})
