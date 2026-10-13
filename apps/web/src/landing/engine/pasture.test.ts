// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The sheep and their grass: each eats now and then, never two at once, and a head is lowered,
 * lifted and shaken smoothly, never flipped.
 */
import { describe, expect, test } from 'bun:test'
import { Cast } from './cast.ts'
import { Pasture } from './pasture.ts'

const DT = 1 / 60
const SECONDS = 300

/** Two patches of four corners, the shape of the cast's. */
const PATCHES = [
  [
    [4.6, 10.6],
    [2.6, 10.6],
    [2.6, 9.2],
    [4.6, 9.2],
  ],
  [
    [6.8, 13.8],
    [4.6, 13.8],
    [4.6, 15.0],
    [6.8, 15.0],
  ],
] as const

/** One sheep's head through a run, frame by frame: how far down it was, its shake, and its meals. */
interface Head {
  down: number
  shake: number
  meals: number
}

/** A step of sheep `index` standing at its first corner, or walking: held to moving smoothly. */
function stepOf(pasture: Pasture, index: number, stop: number, head: Head): boolean {
  const down = pasture.head(index, stop, DT)
  expect(down).toBeGreaterThanOrEqual(0)
  expect(down).toBeLessThanOrEqual(1)
  // Lowered and lifted, never flipped: a twentieth of the way at most in one frame, and a shake of
  // a few degrees a frame.
  expect(Math.abs(down - head.down)).toBeLessThan(0.05)
  expect(Math.abs(pasture.shake - head.shake)).toBeLessThan(0.1)
  if (down > 0.99 && head.down <= 0.99) head.meals += 1
  head.down = down
  head.shake = pasture.shake
  return pasture.eating
}

describe('the sheep graze', () => {
  test('each eats now and then, never at the same time as the other, and the head moves smoothly', () => {
    const pasture = new Pasture(PATCHES)
    const heads: Head[] = [0, 1].map(() => ({ down: 0, shake: 0, meals: 0 }))
    let both = 0
    // Both stand at their first corner for twelve seconds, walk for twelve, and stop again.
    for (let n = 0; n < SECONDS / DT; n++) {
      pasture.draw(DT, () => {})
      const stop = Math.floor((n * DT) / 12) % 2 === 0 ? 0 : -1
      const first = stepOf(pasture, 0, stop, heads[0] as Head)
      const second = stepOf(pasture, 1, stop, heads[1] as Head)
      if (first && second) both++
    }
    expect(both).toBe(0)
    for (const head of heads) expect(head.meals).toBeGreaterThan(5)
  })

  test('in the cast, the herd draws its tufts and the same boxes every frame, and keeps eating', () => {
    const cast = new Cast()
    let busy = 0
    for (let n = 0; n < 120 / DT; n++) {
      let boxes = 0
      if (
        cast.friendsStep(
          0,
          DT,
          () => boxes++,
          () => {},
          0,
        )
      )
        busy++
      // Two sheep of six boxes each, and ten tufts of five blades.
      expect(boxes).toBe(2 * 6 + 10 * 5)
    }
    expect(busy).toBeGreaterThan(0)
  })
})
