// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Time units agree with the runtime's UTC calendar, including millisecond and second API representations. */
import { expect, test } from 'bun:test'
import { DAY_MS, DAY_S, HOUR_MS, HOUR_S, MINUTE_MS, MINUTE_S, SECOND_MS } from './durations.ts'

test('timer units advance UTC by exactly the named calendar field', () => {
  const start = Date.UTC(2024, 1, 28)
  expect(start + SECOND_MS).toBe(Date.UTC(2024, 1, 28, 0, 0, 1))
  expect(start + MINUTE_MS).toBe(Date.UTC(2024, 1, 28, 0, 1))
  expect(start + HOUR_MS).toBe(Date.UTC(2024, 1, 28, 1))
  expect(start + DAY_MS).toBe(Date.UTC(2024, 1, 29))
})

test('API seconds represent the same instants across a leap day', () => {
  const start = Date.UTC(2024, 1, 29)
  const second = Date.UTC(2024, 1, 29, 0, 0, 1) - start
  expect(start + MINUTE_S * second).toBe(Date.UTC(2024, 1, 29, 0, 1))
  expect(start + HOUR_S * second).toBe(Date.UTC(2024, 1, 29, 1))
  expect(start + DAY_S * second).toBe(Date.UTC(2024, 2, 1))
})
