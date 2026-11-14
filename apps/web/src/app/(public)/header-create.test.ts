// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The landing header's band: the section under it is read from a band the header's own height,
 * set in pixels, never as a percentage, which browsers resolve against different sides.
 */
import { describe, expect, test } from 'bun:test'
import { bandUnder } from './header-create'

describe('the band under the landing header', () => {
  test('is the header’s own height at the top of any viewport, wide or tall', () => {
    expect(bandUnder(900, 64)).toBe('0px 0px -836px 0px')
    expect(bandUnder(844, 64)).toBe('0px 0px -780px 0px')
  })

  test('is set in pixels, never a percentage', () => {
    for (const [viewport, header] of [
      [900, 64],
      [640.5, 64],
      [40, 64],
    ] as const)
      expect(bandUnder(viewport, header)).toMatch(/^0px 0px -\d+px 0px$/)
  })
})
