// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A revision identifies a pack by catalog and pinned version, including the absence of a pack. */
import { expect, test } from 'bun:test'
import { samePack } from './modpack.ts'

const first = { catalog: 'first-catalog', versionId: 'release-one' }

test('two absent packs match, and exactly one absent pack does not', () => {
  expect(samePack(null, null)).toBe(true)
  expect(samePack(first, null)).toBe(false)
  expect(samePack(null, first)).toBe(false)
})

test('both the catalog and pinned version must match, regardless of object identity', () => {
  expect(samePack(first, { ...first })).toBe(true)
  expect(samePack(first, { ...first, catalog: 'another-catalog' })).toBe(false)
  expect(samePack(first, { ...first, versionId: 'another-release' })).toBe(false)
  expect(samePack(first, { catalog: 'another-catalog', versionId: 'another-release' })).toBe(false)
})
