// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * That a label falls on the screen where a real client draws it. Each case is a screenshot of a
 * 26.2 client at 1920x1080, field of view 70, the player standing on a block (so the camera is at
 * 1.62 over their feet and no speed widens it), a text display of twelve M on a magenta
 * background eight blocks north of them, and the magenta's box in the picture
 * (`docs/minecraft/readable-text.md`, § Measured).
 */
import { describe, expect, test } from 'bun:test'
import type { Label } from './arcade/datapack.ts'
import { plate, seen } from './sight.ts'

const SCREEN = { width: 1920, height: 1080, fov: 70 }
const VIEW = { eye: [500.5, 151.62, 500.5] as const, yaw: 180, pitch: 0 }
const twelveM = (lines: number, y: number): Label => ({
  at: [500.5, y, 492.5],
  tag: 'calib',
  text: [{ text: Array.from({ length: lines }, () => 'MMMMMMMMMMMM').join('\n'), color: 'white' }],
  facing: 'south',
})

/** Within three pixels of what the client drew: the game rounds each edge to a pixel its own way. */
const near = (actual: number, drawn: number) => expect(Math.abs(actual - drawn)).toBeLessThanOrEqual(3)

describe('where a label falls on the screen', () => {
  test('a line is ten text pixels tall and its words a pixel short of each side', () => {
    expect(plate(twelveM(1, 0))).toEqual({ width: 74 / 40, height: 10 / 40 })
    expect(plate(twelveM(3, 0)).height).toBe(30 / 40)
  })

  test('one line, its foot a quarter block under the eye, as the client drew it: 873 540 to 1048 563', () => {
    const rect = seen(twelveM(1, 151.37), VIEW, SCREEN)
    if (rect === null) throw new Error('Not seen')
    near(rect.left, 873)
    near(rect.top, 540)
    near(rect.right, 1048 + 1)
    near(rect.bottom, 563 + 1)
  })

  test('two and three lines, their foot at 151: 552 to 599, and 527 to 599', () => {
    const two = seen(twelveM(2, 151), VIEW, SCREEN)
    const three = seen(twelveM(3, 151), VIEW, SCREEN)
    near(two?.top ?? 0, 552)
    near(two?.bottom ?? 0, 599 + 1)
    near(three?.top ?? 0, 527)
  })

  test('behind the player, it isn’t seen', () => {
    expect(seen(twelveM(1, 151.37), { ...VIEW, yaw: 0 }, SCREEN)).toBeNull()
  })
})
