// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Cubepals' own style of note writer's picture: the mark's language, four flat shapes on a 2×2
 * grid, each a square, a circle or a square with one corner rounded, all in one of the site's
 * colours on sand. Never in ink, and never the mark's notched shape, so no picture reads as the
 * Cubepals logo. One of the styles `writer-avatar.tsx` draws.
 */

import { random } from '../../ui/face'
import { COLOURS, PAPER } from './avatar-colours'

/** Each of the four cells, left to right and top to bottom, as its corner in a 20-unit square. */
const CELLS = [
  [0, 0],
  [10, 0],
  [0, 10],
  [10, 10],
] as const

/**
 * A shape in a 10-unit cell, drawn from its corner (x, y): sized to the same optical weight as the
 * brand's shapes are, a circle a little wider than a square.
 */
const SHAPES = {
  square: (x: number, y: number) => `M${x + 1} ${y + 1}h8v8h-8z`,
  circle: (x: number, y: number) => `M${x + 0.5} ${y + 5}a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0z`,
  roundedLow: (x: number, y: number) => `M${x + 1} ${y + 1}h8v8h-4a4 4 0 0 1-4-4z`,
  roundedHigh: (x: number, y: number) => `M${x + 1} ${y + 9}v-4a4 4 0 0 1 4-4h4v8z`,
} as const

type Shape = keyof typeof SHAPES

/** What a seed draws: one colour, and a shape for each cell. */
export function markOf(seed: string): { colour: string; shapes: Shape[] } {
  const next = random(seed)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T
  const kinds = Object.keys(SHAPES) as Shape[]
  const colour = pick(COLOURS)
  return { colour, shapes: CELLS.map(() => pick(kinds)) }
}

export function WriterMark({ seed, className }: { seed: string; className?: string }) {
  const { colour, shapes } = markOf(seed)
  const d = shapes.map((shape, i) => {
    const [x, y] = CELLS[i] as (typeof CELLS)[number]
    return SHAPES[shape](x, y)
  })
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden>
      <rect width="20" height="20" fill={PAPER} />
      <path fill={colour} d={d.join('')} />
    </svg>
  )
}
