// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { centreSquare } from './own-icon'

describe('an owner’s own picture', () => {
  test('is cropped to the largest square from its centre', () => {
    expect(centreSquare(1920, 1080)).toEqual({ x: 420, y: 0, side: 1080 })
    expect(centreSquare(300, 501)).toEqual({ x: 0, y: 100, side: 300 })
    expect(centreSquare(64, 64)).toEqual({ x: 0, y: 0, side: 64 })
  })
})
