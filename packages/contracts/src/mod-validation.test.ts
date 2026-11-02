// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { type ModValidationView, modValidationPassed, modValidationPending } from './mod-validation.ts'

test('only a verified check permits play, while unknown and unavailable results keep polling', () => {
  for (const state of ['checking', 'verified', 'blocked', 'unavailable'] as const) {
    const view: ModValidationView = { key: 'check', state, message: null, checkedAt: null }
    expect(modValidationPassed(view)).toBe(state === 'verified')
    expect(modValidationPending(view)).toBe(state === 'checking' || state === 'unavailable')
  }
  for (const absent of [null, undefined]) {
    expect(modValidationPassed(absent)).toBe(true)
    expect(modValidationPending(absent)).toBe(false)
  }
})
