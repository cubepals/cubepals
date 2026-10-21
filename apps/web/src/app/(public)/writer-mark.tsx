// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The small picture beside a note's writer: the mark's own language, four flat shapes on a 2×2
 * grid, each a square, a circle or a square with one corner rounded, all in one of the site's
 * colours on sand. Drawn here from a seed the API gives (a hash of who wrote it), so the same
 * writer always has the same one, nothing leaves Cubepals to draw it, and nothing about the writer
 * can be read from it. The colours are the theme's own, so it changes with the page in dark mode.
 * Not the Cubepals mark: it never draws the mark's notched shape, and is not for anywhere the
 * product names itself.
 */

import { random } from '../../ui/face'

/** The site's colours a writer's shapes may take: ink and the theme's few accents. */
const INKS = ['var(--ink)', 'var(--accent)', 'var(--dusk)', 'var(--status-online)', 'var(--danger)'] as const

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
export function markOf(seed: string): { ink: string; shapes: Shape[] } {
  const next = random(seed)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T
  const kinds = Object.keys(SHAPES) as Shape[]
  const ink = pick(INKS)
  return { ink, shapes: CELLS.map(() => pick(kinds)) }
}

export function WriterMark({ seed, className }: { seed: string; className?: string }) {
  const { ink, shapes } = markOf(seed)
  const d = shapes.map((shape, i) => {
    const [x, y] = CELLS[i] as (typeof CELLS)[number]
    return SHAPES[shape](x, y)
  })
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden>
      <path style={{ fill: ink }} d={d.join('')} />
    </svg>
  )
}
