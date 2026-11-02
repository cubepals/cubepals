// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { brandName, isLevelType, LEVEL_TYPES } from './worlds.ts'

test('known loader brands have readable names and unknown brands keep their own identity', () => {
  expect(brandName('fabric')).toBe('Fabric')
  expect(brandName('unlisted-loader')).toBe('unlisted-loader')
  for (const type of LEVEL_TYPES) expect(isLevelType(type)).toBe(true)
  expect(isLevelType('unlisted-level')).toBe(false)
})
