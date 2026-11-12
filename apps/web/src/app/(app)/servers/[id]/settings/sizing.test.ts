// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which size the game settings need (`sizing.ts`): up for what is slid, never down on its own,
 * only to sizes the plan has, and the size the plan leaves out named for its plan.
 */

import { expect, test } from 'bun:test'
import { capacityOf, holdsOf, lockedFit, mostPlayers, neededSize, type SizeChoice } from './sizing'

const size = (
  value: SizeChoice['value'],
  maxPlayers: number,
  holds = maxPlayers,
  allowed = true,
): SizeChoice => ({
  value,
  label: `Up to ${maxPlayers}`,
  maxPlayers,
  holds,
  allowed,
})
// As the control plane sends them: a size for twenty runs on the machine a size for fifty does.
const PLUS = [size('5', 5), size('10', 10), size('20', 20, 50), size('50', 50), size('more', 100)]
const FREE = [size('5', 5), size('10', 10, 10, false), size('20', 20, 50, false)]
const onFive = { size: '5', holds: 5, capacity: 5 } as const
const at = (players: number, view: number, simulation = view) => ({ players, view, simulation })

test('the size it is on, while it keeps up', () => {
  expect(neededSize(at(5, 10), PLUS, onFive)).toBe('5')
  expect(neededSize(at(2, 12), PLUS, onFive)).toBe('5')
})

test('more players than the size holds moves it up to the smallest that holds them', () => {
  expect(neededSize(at(8, 10), PLUS, onFive)).toBe('10')
  expect(neededSize(at(30, 10), PLUS, onFive)).toBe('50')
})

test('longer distances move it up to the smallest size that keeps up with them', () => {
  // Five on at 12 chunks is busy on a size for five; a size for ten keeps up.
  expect(neededSize(at(5, 12), PLUS, onFive)).toBe('10')
  // At 24 chunks the size for twenty keeps up: it runs on the machine a size for fifty does.
  expect(neededSize(at(5, 24), PLUS, onFive)).toBe('20')
})

test('never down on its own: a big server with little asked of it stays as it is', () => {
  expect(neededSize(at(2, 6), PLUS, { size: '20', holds: 50, capacity: 50 })).toBe('20')
})

test('only sizes the plan has; the one it leaves out is named for its plan', () => {
  expect(neededSize(at(5, 16), FREE, onFive)).toBe('5')
  expect(lockedFit(at(5, 16), FREE, onFive)?.value).toBe('10')
  // Twenty on at 32 chunks: no size the free plan lists keeps up, so no plan to name.
  expect(lockedFit(at(20, 32), FREE, onFive)).toBeUndefined()
})

test('a size is picked by its group and measured by its machine', () => {
  const onTen = { size: '10', holds: 10, capacity: 10 } as const
  // Thirty players read "Up to 50", never "Up to 20", though both run on one machine.
  expect(neededSize(at(30, 10), PLUS, onTen)).toBe('50')
  expect(holdsOf(size('20', 20, 50), onTen)).toBe(20)
  expect(capacityOf(size('20', 20, 50), onTen)).toBe(50)
  // Ten at 24 chunks keeps up on that machine, so the size for twenty does.
  expect(neededSize(at(10, 24), PLUS, onTen)).toBe('20')
})

test('the server’s own size holds what its bounds say; how far the players slider goes', () => {
  expect(holdsOf(size('20', 20, 50), { size: '20', holds: 50, capacity: 50 })).toBe(50)
  expect(mostPlayers(PLUS, onFive)).toBe(100)
  expect(mostPlayers(FREE, onFive)).toBe(5)
})
