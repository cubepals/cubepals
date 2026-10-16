// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { takes, wrongGame } from './clients.ts'

const RELEASES = [
  { name: '26.2', protocol: 776 },
  { name: '1.21.11', protocol: 774 },
  { name: '1.21.10', protocol: 773 },
  { name: '1.21.9', protocol: 773 },
]
const ARCADE = { release: '26.2', protocol: 776, oldest: 776, newest: 776 }

test('a server takes the games in its range, and every one where its route says nothing', () => {
  expect(takes(ARCADE, 776)).toBe(true)
  expect(takes(ARCADE, 774)).toBe(false)
  expect(takes(ARCADE, 777)).toBe(false)
  // ViaVersion: any newer one too.
  expect(takes({ ...ARCADE, newest: undefined }, 777)).toBe(true)
  // ViaBackwards: older ones down to 1.9.
  expect(takes({ release: '26.2', protocol: 776, oldest: 107 }, 774)).toBe(true)
  expect(takes({ release: '26.2', protocol: 776, oldest: 107 }, 47)).toBe(false)
  expect(takes(undefined, 4)).toBe(true)
})

test('a game it can’t take hears which Minecraft the server runs, its own, and what to do', () => {
  expect(wrongGame(ARCADE, 774, RELEASES)).toBe(
    'This server runs Minecraft 26.2. Your game is 1.21.11: switch to 26.2 in the launcher, then join.',
  )
  // Two releases speak 773: the newest names it.
  expect(wrongGame(ARCADE, 773, RELEASES)).toContain('Your game is 1.21.10:')
  // A snapshot, or a release the edge hasn't heard of.
  expect(wrongGame(ARCADE, 1073742166, RELEASES)).toBe(
    'This server runs Minecraft 26.2. Your game is another version: switch to 26.2 in the launcher, then join.',
  )
})
