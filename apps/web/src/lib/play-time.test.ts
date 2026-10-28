// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { hoursAndMinutes } from '@blockly/contracts'

describe('a stretch of play', () => {
  test('is said in hours and minutes, never less than a minute', () => {
    expect(hoursAndMinutes(120)).toBe('2 h')
    expect(hoursAndMinutes(80)).toBe('1 h 20 min')
    expect(hoursAndMinutes(45)).toBe('45 min')
    expect(hoursAndMinutes(0.4)).toBe('1 min')
  })
})
