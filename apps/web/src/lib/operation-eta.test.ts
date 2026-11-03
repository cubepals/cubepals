// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A loader check without a measured estimate reports elapsed time instead of an invented deadline. */
import { expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { etaLine } from './operation-eta.ts'

test('unknown duration reports whole elapsed seconds and clamps clocks before the start', () => {
  const startedAt = '2026-11-03T07:00:00Z',
    at = Date.parse(startedAt)
  expect(etaLine(startedAt, null, at + 12.6 * SECOND_MS)).toBe('12s elapsed')
  expect(etaLine(startedAt, null, at - 5 * SECOND_MS)).toBe('0s elapsed')
  expect(etaLine(null, null, at)).toBe('0s elapsed')
  expect(etaLine(startedAt, 30, at + 10 * SECOND_MS)).toBe('About 20 seconds left')
})
