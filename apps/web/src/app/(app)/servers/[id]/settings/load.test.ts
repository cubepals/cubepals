// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { METER } from '@blockly/contracts/meter'
import { blocksLit, GAME_DEFAULT_DISTANCE, levelOf, loadLine, workload } from './load'

const at = (players: number, view: number, simulation: number, holds = 5) =>
  workload({ players, holds, view, simulation })

test('a full server at Minecraft’s distances is the work its size holds', () => {
  expect(at(5, GAME_DEFAULT_DISTANCE, GAME_DEFAULT_DISTANCE)).toBeCloseTo(1)
  expect(levelOf(at(5, 10, 10))).toBe('comfortable')
})

test('fewer players and shorter distances are lighter', () => {
  expect(levelOf(at(2, 10, 10))).toBe('light')
  // The free trial's caps.
  expect(levelOf(at(5, 8, 6))).toBe('light')
})

test('longer distances with everyone on grow the work by the square around each player', () => {
  expect(levelOf(at(5, 12, 12))).toBe('busy')
  expect(levelOf(at(5, 16, 16))).toBe('heavy')
  expect(levelOf(at(5, 32, 32))).toBe('heavy')
  expect(at(5, 16, 10)).toBeLessThan(at(5, 16, 16))
})

test('the world simulates no further than players see', () => {
  expect(at(5, 6, 32)).toBe(at(5, 6, 6))
})

test('the meter lights at least one block and never past the end', () => {
  expect(blocksLit(0)).toBe(1)
  expect(blocksLit(at(5, 10, 10))).toBe(4)
  expect(blocksLit(at(5, 32, 32))).toBe(METER.blocks)
})

test('the line says who it counts, and offers a bigger size only where there is one', () => {
  expect(loadLine('light', 1, true).line).toBe('With one player on, your server has room to spare.')
  expect(loadLine('heavy', 5, true).line).toBe(
    'With all 5 on at once, expect lag. Shorten the distances, or pick a bigger size below.',
  )
  expect(loadLine('heavy', 100, false).line).toBe(
    'With all 100 on at once, expect lag. Shorten the distances.',
  )
})
