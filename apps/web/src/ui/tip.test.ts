// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { isLight } from './tip'

describe('a tip reads its surface from the text it opens from', () => {
  test('light text, so a dark surface', () => {
    expect(isLight('rgb(248, 247, 245)')).toBe(true)
    expect(isLight('rgba(255, 255, 255, 0.9)')).toBe(true)
  })
  test('dark text, so a light surface', () => {
    expect(isLight('rgb(13, 13, 13)')).toBe(false)
    expect(isLight('rgb(102, 102, 102)')).toBe(false)
  })
})
