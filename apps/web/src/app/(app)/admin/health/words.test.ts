// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { HOUR_S, MINUTE_S } from '@blockly/contracts/durations'
import { dollars, kindLabel, stepLabel, took } from './words'

test('admin operation labels include compatibility checks and preserve unknown API words', () => {
  expect(kindLabel('wake_from_rest')).toBe('Wake from rest')
  expect(kindLabel('a_future_operation')).toBe('a_future_operation')
  expect(stepLabel('checking_mods')).toBe('Checking the server’s mods')
  expect(stepLabel('a_future_stage')).toBe('a_future_stage')
})

test('measured durations retain fractional seconds, minutes, hours and missing values', () => {
  for (const [seconds, label] of [
    [null, '–'],
    [4.2, '4.2s'],
    [45, '45s'],
    [3 * MINUTE_S + 10, '3m 10s'],
    [HOUR_S + 2 * MINUTE_S, '1h 02m'],
  ] as const)
    expect(took(seconds)).toBe(label)
  expect(dollars(1240)).toBe('$12.40')
  expect(dollars(0)).toBe('$0.00')
})
