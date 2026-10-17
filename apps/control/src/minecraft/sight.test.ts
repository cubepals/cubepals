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
import { type Rect, seenBox } from './sight.ts'

const SCREEN = { width: 1920, height: 1080, fov: 70 }
const VIEW = { eye: [500.5, 151.62, 500.5] as const, yaw: 180, pitch: 0 }

/** Within three pixels of what the client drew: the game rounds each edge to a pixel its own way. */
const near = (actual: number, drawn: number) => expect(Math.abs(actual - drawn)).toBeLessThanOrEqual(3)

/**
 * Where the game's own background behind twelve M falls: as wide as their line, 72 of the game's
 * text pixels, and a pixel each side, ten pixels to a line, standing up from where the display is,
 * facing south.
 */
const background = (lines: number, y: number): Rect | null =>
  seenBox([500.5 - 74 / 80, y, 492.5], [500.5 + 74 / 80, y + (lines * 10) / 40, 492.5], VIEW, SCREEN)

describe('where a label falls on the screen', () => {
  test('one line, its foot a quarter block under the eye, as the client drew it: 873 540 to 1048 563', () => {
    const rect = background(1, 151.37)
    if (rect === null) throw new Error('Not seen')
    near(rect.left, 873)
    near(rect.top, 540)
    near(rect.right, 1048 + 1)
    near(rect.bottom, 563 + 1)
  })

  test('two and three lines, their foot at 151: 552 to 599, and 527 to 599', () => {
    const two = background(2, 151)
    const three = background(3, 151)
    near(two?.top ?? 0, 552)
    near(two?.bottom ?? 0, 599 + 1)
    near(three?.top ?? 0, 527)
  })

  test('behind the player, it isn’t seen', () => {
    expect(seenBox([500, 151, 492.5], [501, 152, 492.5], { ...VIEW, yaw: 0 }, SCREEN)).toBeNull()
  })
})
