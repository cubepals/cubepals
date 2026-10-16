// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { joinsLine } from './joins-line'

test('which versions join a server, from what its settings say', () => {
  const on = (oldest: string, newer: boolean) => ({
    gameVersion: '26.2',
    joins: { oldest, newer, otherVersions: 'on' as const },
  })
  expect(joinsLine(on('1.9', true))).toBe('Players on Minecraft 1.9 to 26.2 and newer can join.')
  expect(joinsLine(on('1.7.2', true))).toBe('Players on Minecraft 1.7.2 to 26.2 and newer can join.')
  expect(joinsLine(on('26.2', true))).toBe('Players on Minecraft 26.2 and newer can join.')
  expect(joinsLine(on('26.2', false))).toBe('Only players on Minecraft 26.2 can join.')
  expect(joinsLine({ gameVersion: '27.1', joins: null })).toBe('Only players on Minecraft 27.1 can join.')
})
