// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { startingRegion } from './nearest-region'

const BOTH = ['eu', 'us']

describe('the region a new server starts in', () => {
  test('Europe for Europe, the Middle East, Africa and South Asia', () => {
    for (const country of ['SA', 'DE', 'GB', 'EG', 'IN'])
      expect(startingRegion(country, BOTH)).toEqual({ key: 'eu', nearest: true })
  })

  test('North America for the Americas', () => {
    for (const country of ['US', 'CA', 'MX', 'BR'])
      expect(startingRegion(country, BOTH)).toEqual({ key: 'us', nearest: true })
  })

  test('the first region, not said to be nearest, when the country is unknown or missing', () => {
    expect(startingRegion(null, BOTH)).toEqual({ key: 'eu', nearest: false })
    expect(startingRegion('', BOTH)).toEqual({ key: 'eu', nearest: false })
    expect(startingRegion('XX', BOTH)).toEqual({ key: 'eu', nearest: false })
    expect(startingRegion(null, ['us', 'eu'])).toEqual({ key: 'us', nearest: false })
  })

  test('reads the header as an edge may send it', () => {
    expect(startingRegion(' us ', BOTH)).toEqual({ key: 'us', nearest: true })
  })

  test('the next nearest that is offered, when the nearest is not', () => {
    expect(startingRegion('DE', ['us'])).toEqual({ key: 'us', nearest: true })
  })

  test('never a region whose place it does not know', () => {
    expect(startingRegion('US', ['local'])).toEqual({ key: 'local', nearest: false })
    expect(startingRegion('US', ['ap', 'eu'])).toEqual({ key: 'eu', nearest: true })
  })

  test('nothing when nothing is offered', () => {
    expect(startingRegion('US', [])).toBeNull()
  })
})
