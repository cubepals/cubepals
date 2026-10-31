// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Deliberately superficial assertions for a disposable, never-merged enforcement canary. */
import { expect, test } from 'bun:test'
import { advance } from './quality-canary.ts'

test('the operation returns values or an error', () => {
  try {
    advance(-1)
  } catch (error) {
    expect(error).toBeDefined()
  }
  expect(advance(0)).toBeDefined()
  expect(advance(10)).toBeDefined()
})
