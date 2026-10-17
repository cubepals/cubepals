// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The pictures in Cubepals' resource pack (`brand-pack.ts`), drawn from source rather than kept as
 * images: the mark from its own shapes in `brand/mark.svg`, sampled into pixels, and around it the
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

/** Every texture's side, in pixels: twice the game's, so the mark keeps its four shapes. */
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
 * The mark drawn on a grid of pixels: each of its four shapes in a cell `cell` pixels square, with
 * a pixel between them, as the hall's mark in blocks is (`scripts/lib/arcade-brand.ts`), since
 * below the brand's twenty pixels the four would run together. Each pixel is sampled `samples` by
 * `samples`; an odd number leaves no pixel half in, so the square, which sits inside its cell,
 * keeps its corners.
 */
export function markPixels(cell: number, samples = 4): boolean[][] {
  const size = 2 * cell + 1
  const side = (n: number): 0 | 1 | null => (n < cell ? 0 : n > cell ? 1 : null)
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => {
      const [across, down] = [side(column), side(row)]
      return across !== null && down !== null && mostlyMark(cell, samples, across, down, column, row)
    }),
  )
}

/**
 * Whether at least half of a pixel in the cell `across` and `down` (each 0 or 1) is its shape's:
 * sampled `samples` by `samples` in the shape's own 300-unit cell of the view box, with the view
 * box's margin.
 */
function mostlyMark(
  cell: number,
  samples: number,
  across: 0 | 1,
  down: 0 | 1,
  column: number,
  row: number,
): boolean {
  const [cx, cy] = [column - across * (cell + 1), row - down * (cell + 1)]
  let covered = 0
  for (let sy = 0; sy < samples; sy++)
    for (let sx = 0; sx < samples; sx++) {
      const x = across * 300 + VIEW.origin + ((cx + (sx + 0.5) / samples) / cell) * (VIEW.size / 2)
      const y = down * 300 + VIEW.origin + ((cy + (sy + 0.5) / samples) / cell) * (VIEW.size / 2)
      if (inMark([x, y])) covered++
    }
  return covered >= Math.ceil((samples * samples) / 2)
}

const rgb = (hex: string): readonly [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]

/** A picture to draw on: clear to start with, and filled a rectangle or the mark at a time. */
function canvas(side: number) {
  const rgba = new Uint8Array(side * side * 4)
  const dot = (x: number, y: number, hex: string) => {
    if (x < 0 || y < 0 || x >= side || y >= side) return
    rgba.set([...rgb(hex), 255], (y * side + x) * 4)
  }
  return {
    /** Fills from (x, y), `width` across and `height` down. */
    rect(x: number, y: number, width: number, height: number, hex: string) {
      for (let row = y; row < y + height; row++)
        for (let column = x; column < x + width; column++) dot(column, row, hex)
    },
    /** The mark, its shapes `cell` pixels square, its top left at (x, y). */
    mark(x: number, y: number, cell: number, hex: string) {
      markPixels(cell).forEach((row, r) => {
        row.forEach((on, c) => {
          if (on) dot(x + c, y + r, hex)
        })
      })
    },
    picture: (): Picture => ({ width: side, height: side, rgba }),
  }
}

/** A door's frame: Paper inside an edge of Ink, as every Cubepals block has, from `top` to the ground. */
function frame(draw: ReturnType<typeof canvas>, top: number) {
  draw.rect(6, top, 20, SIDE - top, INK)
  draw.rect(7, top + 1, 18, SIDE - top - 1, PAPER)
}

/** The door the "Back to the hub" item shows: shut, Ink, the mark on it in Paper, and an indigo handle. */
export function backToHub(): Picture {
  const draw = canvas(SIDE)
  frame(draw, 1)
  draw.rect(9, 4, 14, SIDE - 4, INK)
  draw.mark(10, 7, 5, PAPER)
  draw.rect(19, 21, 2, 2, INDIGO)
  return draw.picture()
}

/** The open door over a way through: its leaf swung back against the frame, and indigo light in the doorway. */
export function wayOut(): Picture {
  const draw = canvas(SIDE)
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
  const cell = Math.floor((Math.floor(side / 1.5) - 1) / 2)
  const at = Math.floor((side - (2 * cell + 1)) / 2)
  draw.mark(at, at, cell, INK)
  return draw.picture()
}
