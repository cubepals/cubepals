// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/** A print is a whole number of dots, each a whole number of device pixels, at any density. */
import { describe, expect, test } from 'bun:test'
import { fitted, unitOf } from './dots'

describe('the print’s dots', () => {
  test('two device pixels a dot at one to a CSS pixel, three at more', () => {
    for (const [ratio, device] of [
      [1, 2],
      [1.25, 2],
      [1.5, 3],
      [2, 3],
      [2.625, 3],
      [3, 3],
    ] as const)
      expect(unitOf(ratio) * ratio).toBeCloseTo(device, 9)
  })

  test('the largest whole print that fits, and never past its box', () => {
    for (const ratio of [1, 1.25, 2, 2.625, 3])
      for (const [width, height] of [
        [565, 530],
        [350, 328],
        [1203, 777],
      ] as const) {
        const print = fitted(width, height, ratio)
        expect(Number.isInteger(print.across) && Number.isInteger(print.down)).toBe(true)
        expect(print.width).toBeLessThanOrEqual(width)
        expect(print.height).toBeLessThanOrEqual(height)
        expect(width - print.width).toBeLessThan(print.unit)
        // Each dot lands on whole device pixels.
        expect((print.width * ratio) % 1).toBeCloseTo(0, 6)
      }
  })
})
