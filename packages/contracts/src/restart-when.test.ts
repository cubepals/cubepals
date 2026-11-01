// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The restart choice accepts only the two deliberate timings exposed by the API. */
import { expect, test } from 'bun:test'
import { RESTART_WHEN, RestartWhen } from './restart-when.ts'

test('restart timing retains its public choices and refuses every other value', () => {
  expect(RESTART_WHEN).toEqual(['empty', 'now'])
  expect(RestartWhen.parse('empty')).toBe('empty')
  expect(RestartWhen.parse('now')).toBe('now')
  for (const value of ['', 'later', null, undefined, 0])
    expect(RestartWhen.safeParse(value).success).toBe(false)
})
