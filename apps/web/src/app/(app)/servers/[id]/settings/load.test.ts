// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The load estimate the settings page's meter shows (`load.ts`): its levels, its blocks, its words,
 * and which size it offers when the work is past comfortable.
 */

import { expect, test } from 'bun:test'
import { DEFAULT_DISTANCE } from '@blockly/contracts/game-defaults'
import { METER } from '@blockly/contracts/meter'
import { blocksLit, levelOf, loadLine, sizeThatFits, workload } from './load'

const at = (players: number, view: number, simulation: number, holds = 5) =>
  workload({ players, holds, view, simulation })

test('a full server at Minecraft’s distances is the work its size holds', () => {
  expect(at(5, DEFAULT_DISTANCE, DEFAULT_DISTANCE)).toBeCloseTo(1)
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

test('the line says who it counts', () => {
  expect(loadLine('light', 1).line).toBe('With one player on, your server has room to spare.')
  expect(loadLine('light', 2).line).toBe('With both on at once, your server has room to spare.')
  expect(loadLine('heavy', 5).line).toBe('With all 5 on at once, expect lag.')
})

const [five, ten, twenty, fifty] = [
  { value: '5', maxPlayers: 5, allowed: true },
  { value: '10', maxPlayers: 10, allowed: true },
  { value: '20', maxPlayers: 20, allowed: false },
  { value: '50', maxPlayers: 50, allowed: false },
] as const
const SIZES = [five, ten, twenty, fifty]

test('past comfortable, the smallest bigger size that keeps up easily is offered', () => {
  // Five on at 12 chunks is busy on a size for five; a size for ten halves it.
  expect(sizeThatFits({ players: 5, holds: 5, view: 12, simulation: 12 }, SIZES)).toEqual({
    size: ten,
    fits: true,
  })
  // At 32 chunks only a size the plan doesn't have keeps up: it is offered, for the page to show its plan.
  expect(sizeThatFits({ players: 5, holds: 5, view: 32, simulation: 32 }, SIZES)?.size.value).toBe('50')
})

test('when no bigger size keeps up, the biggest is offered as easing it; none, when none is bigger', () => {
  expect(sizeThatFits({ players: 50, holds: 10, view: 32, simulation: 32 }, SIZES)).toEqual({
    size: fifty,
    fits: false,
  })
  expect(sizeThatFits({ players: 50, holds: 50, view: 32, simulation: 32 }, SIZES)).toBeNull()
})
