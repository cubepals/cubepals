// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The stills are the scene's own prints: each is a whole number of dots for its density, as the
 * scene prints the box they were printed for, so neither is ever shown scaled; and their marks are
 * where the scene puts them, at the camera the stills were printed with.
 */
import { describe, expect, test } from 'bun:test'
import { fitted } from './dots'
import { marksOf, openingCamera } from './scene'
import { PRINTED, SMALL, SMALL_BOX, STILL_MARKS, STILLS } from './stills'

describe('the island’s stills', () => {
  test('their marks are the scene’s own: a change of camera or cut means printing them again', () => {
    const marks = marksOf(openingCamera(PRINTED.width / PRINTED.height))
    for (const [key, said] of Object.entries(STILL_MARKS)) {
      const real = marks[key as keyof typeof marks]
      if (typeof said === 'number') expect(real).toBe(said)
      else if (said === null) expect(real).toBeNull()
      else {
        const [x, y] = real as readonly [number, number]
        expect(x).toBeCloseTo(said[0], 3)
        expect(y).toBeCloseTo(said[1], 3)
      }
    }
  })

  test('each is printed dot for dot for its density: three device pixels a dot when fine, two when coarse', () => {
    const fine = fitted(PRINTED.width, PRINTED.height, 2)
    const coarse = fitted(PRINTED.width, PRINTED.height, 1)
    for (const still of Object.values(STILLS)) {
      const sized = (print: { width: number; height: number }): number[] => [print.width, print.height]
      expect(sized(still.fine)).toEqual([fine.across, fine.down])
      expect(sized(still.coarse)).toEqual([coarse.across, coarse.down])
    }
  })

  test('the smaller ones are the scene’s print of their box at two device pixels a dot, and at three the coarse ones', () => {
    const two = fitted(SMALL_BOX.width, SMALL_BOX.height, 1)
    const three = fitted(SMALL_BOX.width, SMALL_BOX.height, 2)
    const sized = (print: { width: number; height: number }): number[] => [print.width, print.height]
    for (const [which, still] of Object.entries(SMALL)) {
      expect(sized(still)).toEqual([two.across, two.down])
      expect(sized(STILLS[which as keyof typeof STILLS].coarse)).toEqual([three.across, three.down])
    }
  })
})
