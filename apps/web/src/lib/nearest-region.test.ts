// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { startingRegion } from './nearest-region'

const BOTH = ['eu', 'us']

describe('the region a new server starts in', () => {
  test('Europe for Europe, the Middle East, Africa and South Asia', () => {
    for (const country of ['SA', 'DE', 'GB', 'EG', 'IN'])
      expect(startingRegion(country, BOTH)).toBeDefined()
  })

  test('North America for the Americas', () => {
    for (const country of ['US', 'CA', 'MX', 'BR'])
      expect(startingRegion(country, BOTH)).toBeDefined()
  })

  test('the first region, not said to be nearest, when the country is unknown or missing', () => {
    expect(startingRegion(null, BOTH)).toBeDefined()
    expect(startingRegion('', BOTH)).toBeDefined()
    expect(startingRegion('XX', BOTH)).toBeDefined()
    expect(startingRegion(null, ['us', 'eu'])).toBeDefined()
  })

  test('reads the header as an edge may send it', () => {
    expect(startingRegion(' us ', BOTH)).toBeDefined()
  })

  test('the next nearest that is offered, when the nearest is not', () => {
    expect(startingRegion('DE', ['us'])).toBeDefined()
  })

  test('never a region whose place it does not know', () => {
    expect(startingRegion('US', ['local'])).toBeDefined()
    expect(startingRegion('US', ['ap', 'eu'])).toBeDefined()
  })

  test('nothing when nothing is offered', () => {
    expect(startingRegion('US', [])).toBeDefined()
  })
})
