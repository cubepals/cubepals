// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The stack's dither: a 4 by 4 tile filled in the ordered dither's own order, a dot showing where
 * its number is under the level. Each level keeps every dot of the one below, so a dissolve from
 * one level to the next only adds dots and never moves one.
 */

export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const
export const LEVELS = 16

const tiles = new Map<number, string>()

/** The tile at `level` as a CSS mask image, one SVG pixel a dot; the page sizes it to the print's dots. */
export function tileOf(level: number): string {
  const known = tiles.get(level)
  if (known) return known
  const dots = BAYER.map((order, i) =>
    order < level ? `<rect x='${i % 4}' y='${Math.floor(i / 4)}' width='1' height='1' fill='white'/>` : '',
  ).join('')
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4' shape-rendering='crispEdges'>${dots}</svg>`
  const made = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  tiles.set(level, made)
  return made
}
