// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { versionsThatJoin } from '@blockly/contracts'

test('the versions that join, said the same wherever a page names them', () => {
  // Other versions off: the one version.
  expect(versionsThatJoin('1.21.11', { oldest: '1.21.11', newer: false })).toBe('1.21.11')
  expect(versionsThatJoin('27.1', null)).toBe('27.1')
  // Newer ones only, and older ones down to what ViaBackwards and ViaRewind reach.
  expect(versionsThatJoin('1.21.11', { oldest: '1.21.11', newer: true })).toBe('1.21.11 or newer')
  expect(versionsThatJoin('26.2', { oldest: '1.9', newer: true })).toBe('1.9 or newer')
  expect(versionsThatJoin('1.21.11', { oldest: '1.7.2', newer: true })).toBe('1.7.2 or newer')
  expect(versionsThatJoin('26.2', { oldest: '1.9', newer: false })).toBe('1.9 to 26.2')
})
