// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { atLimitOf } from './limit.ts'

describe('what stands in the way of a new server', () => {
  const full = { feature: 'create_server' as const, available: false, code: 'platform_full' as const }

  test('with no room, the page says Cubepals is full before anything is filled in, even for a replacement', () => {
    const said = 'Cubepals is full right now. Try again in a few minutes.'
    expect(atLimitOf({ ...full, message: 'Cubepals is full right now, so nothing was made.' }, null)).toBe(
      said,
    )
    expect(atLimitOf(full, 'server-1')).toBe(said)
  })

  test('a plan’s own limit says its words, and a replacement makes way past it', () => {
    const limit = {
      feature: 'create_server' as const,
      available: false,
      code: 'limit_reached' as const,
      message: 'Your plan includes 1 server.',
    }
    expect(atLimitOf(limit, null)).toBe('Your plan includes 1 server.')
    expect(atLimitOf(limit, 'server-1')).toBeNull()
    expect(atLimitOf({ feature: 'create_server', available: true }, null)).toBeNull()
  })
})
