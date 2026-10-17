// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where words in the world can be read: the rules every arrival's and every pad's words on
 * Cubepals' servers are placed by, each from what is known of the game, of players' screens and of
 * reading, and from what a real client showed (`docs/minecraft/readable-text.md`). A label is read
 * from where a player first sees it, standing, looking the way they face there (`View`), on the
 * screens most players have, at the field of view the game starts with and at its widest. Not where
 * any label is, which each game's file says.
 */
import type { Label } from './arcade/datapack.ts'
import { lineWidths } from './arcade/label-space.ts'
import { type Point, plate, type Rect, type Screen, seen, type View } from './sight.ts'

/** A label, and where a player first sees it from: an arrival, or the way to a pad. */
export interface Read {
  label: Label
  from: View
  /** An arrival the game puts its title on: the words stand clear over it. */
  titled?: boolean
}

/** A player's eye over their feet, standing (the game's `Avatar.DEFAULT_EYE_HEIGHT`). */
const EYE = 1.62

/** Where a player stands, as a command puts them, `x y z yaw pitch`, as the view from their eye. */
export function viewFrom(place: string): View {
  const [x = 0, y = 0, z = 0, yaw = 0, pitch = 0] = place.split(' ').map(Number)
  return { eye: [x, y + EYE, z], yaw, pitch }
}

/** The view from a place toward a point: level, turned to face it. */
export function lookingAt(feet: Point, at: Point): View {
  const [dx, dz] = [at[0] - feet[0], at[2] - feet[2]]
  return { eye: [feet[0], feet[1] + EYE, feet[2]], yaw: (Math.atan2(-dx, dz) * 180) / Math.PI, pitch: 0 }
}

/**
 * The screens a label must read on: 16:9, four in five of players' main screens, and 16:10, the
 * next most (Steam Hardware Survey), each at the game's default field of view, 70, and its widest,
 * 110. A wider field shows the same words smaller, a narrower screen cuts its sides.
 */
const SCREENS: readonly Screen[] = [
  { width: 1920, height: 1080, fov: 70 },
  { width: 1920, height: 1080, fov: 110 },
  { width: 1920, height: 1200, fov: 70 },
  { width: 1920, height: 1200, fov: 110 },
]

/** The screen the size rule is held at: the most common, at the game's default field of view. */
const READING_SCREEN = { width: 1920, height: 1080, fov: 70 }

/** The least a letter may be, top to bottom, on that screen: the Xbox guidelines' least for PC, 18 pixels at 1080p. */
export const LEAST_LETTER = 18

/** A letter's height in the game's text pixels: its glyphs are eight tall (the game's font). */
const LETTER = 8

/** Comfortable reading: the words' middle within 15 degrees over or under a level look (CCOHS). */
export const MOST_TILT = 15

/** Primary content: within a 41 degree wide middle of the view (Android XR's guidelines). */
export const WIDEST = 41

/** One line of what to do, under the game's name: our choice, as no guideline gives a count of lines (`docs/minecraft/readable-text.md`). */
const MOST_LINES = 2

/**
 * The least gap between two things on the screen, in pixels at 1080p: a margin we chose, twice the
 * most the model and a client differed on an edge (4 pixels), so what the model keeps apart stays apart.
 */
const LEAST_GAP = 8

const degrees = (radians: number) => (radians * 180) / Math.PI

/** A label's middle, over or under a level look from the eye, in degrees: over is more than 0. */
function tilt(label: Label, view: View): number {
  const { height } = plate(label)
  const [x, y, z] = label.at
  const flat = Math.hypot(x - view.eye[0], z - view.eye[2])
  return degrees(Math.atan2(y + height / 2 - view.eye[1], flat))
}

/** How wide a label looks from the eye, in degrees. */
function breadth(label: Label, view: View): number {
  const { width } = plate(label)
  const [x, , z] = label.at
  const flat = Math.hypot(x - view.eye[0], z - view.eye[2])
  return degrees(2 * Math.atan(width / 2 / flat))
}

/** How tall a letter of a label looks on the reading screen, in pixels. */
export function letterPixels(label: Label, view: View): number {
  const rect = seen(label, { ...view, pitch: 0 }, READING_SCREEN)
  if (rect === null) return 0
  const lines = lineWidths(label.widest ?? label.text).length
  return ((rect.bottom - rect.top) / (lines * 10)) * LETTER
}

const inside = (rect: Rect, screen: Screen) =>
  rect.left >= 0 && rect.top >= 0 && rect.right <= screen.width && rect.bottom <= screen.height

/** Each rule a label breaks, read from where it is first seen: none, if it reads as it should. */
export function unreadable(label: Label, view: View): string[] {
  const broken: string[] = []
  const lines = lineWidths(label.widest ?? label.text).length
  if (lines > MOST_LINES) broken.push(`${lines} lines, more than ${MOST_LINES}`)
  const letter = letterPixels(label, view)
  if (letter < LEAST_LETTER) broken.push(`letters ${letter.toFixed(1)} pixels tall, under ${LEAST_LETTER}`)
  const leaning = tilt(label, view)
  if (Math.abs(leaning) > MOST_TILT) broken.push(`${leaning.toFixed(1)} degrees off a level look`)
  const wide = breadth(label, view)
  if (wide > WIDEST) broken.push(`${wide.toFixed(1)} degrees wide`)
  for (const screen of SCREENS) {
    const rect = seen(label, view, screen)
    if (rect === null || !inside(rect, screen))
      broken.push(`not all on a ${screen.width}x${screen.height} screen at field of view ${screen.fov}`)
  }
  return broken
}

/**
 * Where an arrival's title starts on the reading screen, its top, in pixels: the game draws it 40
 * GUI pixels over the middle (`Hud`), at the GUI scale "Auto" picks there, 4 (`Window.calculateScale`).
 */
const TITLE_TOP = READING_SCREEN.height / 2 - 40 * 4

/** Each rule an arrival's words break against its title: none, if they stand clear over it. */
export function underTitle(read: Read): string[] {
  if (read.titled !== true) return []
  const rect = seen(read.label, read.from, READING_SCREEN)
  return rect !== null && rect.bottom + LEAST_GAP > TITLE_TOP
    ? [`its foot ${rect.bottom.toFixed(0)} pixels down, under the title's top at ${TITLE_TOP}`]
    : []
}

/** Whether two places on the screen are closer than the least gap, or overlap. */
export function crowd(a: Rect, b: Rect): boolean {
  return (
    a.left < b.right + LEAST_GAP &&
    b.left < a.right + LEAST_GAP &&
    a.top < b.bottom + LEAST_GAP &&
    b.top < a.bottom + LEAST_GAP
  )
}
