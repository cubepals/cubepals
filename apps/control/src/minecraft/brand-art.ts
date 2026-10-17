// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The pictures in Cubepals' resource pack (`brand-pack.ts`), drawn from source rather than kept as
 * images: the mark from its own shapes in `brand/mark.svg`, sampled into pixels fine enough that its
 * circles are round (`DETAIL`), and around it the
 * door that takes a player back to the hub and the open door over every way through, and the pack's
 * own picture, the mark in Ink on Paper as Cubepals' servers show it. Ink and Paper, the brand's
 * two colours, with the beta's indigo where light comes through (`brand/README.md`). Each picture is whole pixels, as the game's
 * own textures are: nothing is blended at an edge. Not how the pack is put together or offered.
 *
 * The art is Cubepals' own, as the brand's files are (`brand/LICENSE.md`).
 */
import { INDIGO, INK, PAPER } from './arcade/datapack.ts'

/** A picture as the game reads a texture: rows of RGBA, top first. */
export interface Picture {
  width: number
  height: number
  rgba: Uint8Array
}

/** Every door's drawing, in units: a grid of 32, twice the game's 16. */
export const SIDE = 32

type Point = readonly [number, number]

/** `brand/mark.svg`'s view box: the mark's shapes are drawn in it. */
const VIEW = { origin: -1.39, size: 602.78 }

/** The notched square's outline, from the path in `brand/mark.svg`: its S-curve, edge and rounded corner. */
const NOTCHED: readonly Point[] = (() => {
  const points: Point[] = []
  const curve = (p0: Point, p1: Point, p2: Point, p3: Point) => {
    for (let i = 0; i <= 32; i++) {
      const t = i / 32
      const u = 1 - t
      points.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ])
    }
  }
  curve([301.35, 301.35], [421.91, 301.35], [406.36, 409.12], [462.77, 409.12])
  // `A41.14 41.91 0 0 1`: a quarter of an ellipse round (557.51, 451.03), from its top to its right.
  for (let i = 0; i <= 16; i++) {
    const angle = (Math.PI / 2) * (1 - i / 16)
    points.push([557.51 + 41.14 * Math.cos(angle), 451.03 - 41.91 * Math.sin(angle)])
  }
  points.push([598.65, 598.65], [301.35, 598.65])
  return points
})()

/** Whether a point is inside a closed outline, by the crossings of a ray to its right. */
function within(outline: readonly Point[], [x, y]: Point): boolean {
  let inside = false
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i] ?? [0, 0]
    const [xj, yj] = outline[j] ?? [0, 0]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Whether a point of `brand/mark.svg`'s view box is in the mark: its square, two circles or notched square. */
function inMark([x, y]: Point): boolean {
  const square = x >= 15.84 && x <= 284.17 && y >= 15.84 && y <= 284.17
  const circle = (cx: number, cy: number) => (x - cx) ** 2 + (y - cy) ** 2 <= 151.39 ** 2
  return square || circle(450, 150) || circle(150, 450) || within(NOTCHED, [x, y])
}

/**
 * Whether a point of the mark's square is in the mark, the square read from its top left (0, 0) to
 * its bottom right (1, 1) as `brand/mark.svg`'s view box: for drawing it at any size, its shapes
 * exact, as map art does (`map-art.ts`).
 */
export const markAt = (u: number, v: number): boolean =>
  inMark([VIEW.origin + u * VIEW.size, VIEW.origin + v * VIEW.size])

const rgb = (hex: string): readonly [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]

/** Pixels of a door's picture to a unit of its drawing: its frame on a grid of 32, the mark four times finer, so its circles are round. */
export const DETAIL = 4

/** Samples to a pixel each way: a pixel is the mark's where at least half of them are in it. */
const SAMPLES = 3

/**
 * Whether a pixel is the mark's, the mark drawn `size` pixels square from (0, 0): at least half of
 * the points sampled across it are in the mark. Pixels round the mark are not; `x` and `y` may be
 * fractions, for a mark that doesn't start on a whole pixel.
 */
export function markPixel(x: number, y: number, size: number): boolean {
  let covered = 0
  for (let sy = 0; sy < SAMPLES; sy++)
    for (let sx = 0; sx < SAMPLES; sx++) {
      const [u, v] = [(x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size]
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1 && markAt(u, v)) covered++
    }
  return covered * 2 >= SAMPLES * SAMPLES
}

/**
 * A picture to draw on, clear to start with, `side` units square at `detail` pixels to a unit,
 * filled a rectangle or the mark at a time.
 */
function canvas(side: number, detail = 1) {
  const pixels = side * detail
  const rgba = new Uint8Array(pixels * pixels * 4)
  const dot = (x: number, y: number, hex: string) => {
    if (x < 0 || y < 0 || x >= pixels || y >= pixels) return
    rgba.set([...rgb(hex), 255], (y * pixels + x) * 4)
  }
  return {
    /** Fills from (x, y), `width` across and `height` down, in units. */
    rect(x: number, y: number, width: number, height: number, hex: string) {
      for (let row = y * detail; row < (y + height) * detail; row++)
        for (let column = x * detail; column < (x + width) * detail; column++) dot(column, row, hex)
    },
    /** The mark, `size` units square, its top left at (x, y), drawn from its own shapes. */
    mark(x: number, y: number, size: number, hex: string) {
      const across = size * detail
      for (let row = 0; row < across; row++)
        for (let column = 0; column < across; column++)
          if (markPixel(column, row, across)) dot(x * detail + column, y * detail + row, hex)
    },
    picture: (): Picture => ({ width: pixels, height: pixels, rgba }),
  }
}

/** A door's frame: Paper inside an edge of Ink, as every Cubepals block has, from `top` to the ground. */
function frame(draw: ReturnType<typeof canvas>, top: number) {
  draw.rect(6, top, 20, SIDE - top, INK)
  draw.rect(7, top + 1, 18, SIDE - top - 1, PAPER)
}

/** The door the "Back to the hub" item shows: shut, Ink, the mark on it in Paper, and an indigo handle. */
export function backToHub(): Picture {
  const draw = canvas(SIDE, DETAIL)
  frame(draw, 1)
  draw.rect(9, 4, 14, SIDE - 4, INK)
  draw.mark(10, 7, 11, PAPER)
  draw.rect(19, 21, 2, 2, INDIGO)
  return draw.picture()
}

/** The open door over a way through: its leaf swung back against the frame, and indigo light in the doorway. */
export function wayOut(): Picture {
  const draw = canvas(SIDE, DETAIL)
  frame(draw, 1)
  draw.rect(9, 4, 14, SIDE - 4, INDIGO)
  draw.rect(9, 4, 4, SIDE - 4, INK)
  return draw.picture()
}

/**
 * Cubepals' own servers' look, as their server-list picture is: the mark alone in Ink on a square
 * of Paper, square corners, with the brand's clear space round it, a quarter of its height.
 */
export function badge(side: number): Picture {
  const draw = canvas(side)
  draw.rect(0, 0, side, side, PAPER)
  const mark = Math.floor(side / 1.5)
  const at = Math.floor((side - mark) / 2)
  draw.mark(at, at, mark, INK)
  return draw.picture()
}
