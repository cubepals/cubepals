// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The view and simulation distances drawn to scale from above, with a legend in blocks. Only the
 * game form's numbers use it (`game-numbers.tsx`); it reads no settings of its own.
 */

import { useId } from 'react'
import { CHUNK_BLOCKS } from './load'
import styles from './reach.module.css'

/** The drawing's side and the room left round it, in CSS pixels: one unit is one pixel. */
const SIDE = 176
const EDGE = 4

/**
 * The world around one player, seen from above and drawn to scale while the owner slides: the
 * chunks they see, the chunks that keep moving inside them, and the player's own chunk at the
 * centre. Grey is a dither of Ink, as the brand draws depth. The frame is the furthest distance
 * the page allows, so a full square is the most this server can have. The words beside it carry
 * what it shows; the drawing itself is hidden from screen readers.
 */
export function ReachMap({ view, simulation, max }: { view: number; simulation: number; max: number }) {
  const id = useId()
  const seen = `${id}-seen`
  const moving = `${id}-moving`
  const moves = Math.min(view, simulation)
  const cell = (SIDE - 2 * EDGE) / (2 * max + 1)
  // Chunk lines no closer than 8 pixels: every chunk when they fit, else every second or fourth.
  const step = [1, 2, 4, 8].find((n) => n * cell >= 8) ?? 8
  const centre = SIDE / 2
  const half = (distance: number) => (distance + 0.5) * cell
  const square = (distance: number) => ({
    x: centre - half(distance),
    y: centre - half(distance),
    width: 2 * half(distance),
    height: 2 * half(distance),
  })
  // Each line closes a ring of chunks at a multiple of the step, so even distances land on one.
  const lines = Array.from({ length: Math.floor((max - 1) / step) }, (_, i) => half((i + 1) * step))
  return (
    <figure className={styles.figure}>
      <svg
        className={styles.map}
        width={SIDE}
        height={SIDE}
        viewBox={`0 0 ${SIDE} ${SIDE}`}
        shapeRendering="crispEdges"
        aria-hidden
      >
        <defs>
          <pattern id={seen} width={3} height={3} patternUnits="userSpaceOnUse">
            <rect width={1} height={1} className={styles.ink} />
          </pattern>
          <pattern id={moving} width={2} height={2} patternUnits="userSpaceOnUse">
            <rect width={1} height={1} className={styles.ink} />
            <rect x={1} y={1} width={1} height={1} className={styles.ink} />
          </pattern>
        </defs>
        <rect {...square(max)} className={styles.ground} />
        {lines.flatMap((offset) =>
          [-offset, offset].map((d) => (
            <g key={d} className={styles.grid}>
              <line x1={centre + d} x2={centre + d} y1={EDGE} y2={SIDE - EDGE} />
              <line y1={centre + d} y2={centre + d} x1={EDGE} x2={SIDE - EDGE} />
            </g>
          )),
        )}
        <rect {...square(view)} fill={`url(#${seen})`} className={styles.edge} />
        <rect {...square(moves)} fill={`url(#${moving})`} className={styles.edge} />
        <rect {...square(0)} className={styles.player} />
      </svg>
      <figcaption className={styles.legend}>
        <span className={`${styles.title} type-eyebrow`}>Around each player</span>
        <Key pattern={seen} said={`They see ${blocks(view)} each way`} />
        <Key
          pattern={moving}
          said={
            simulation > view
              ? `The world moves as far as they see: ${blocks(moves)}`
              : `The world moves ${blocks(moves)} each way`
          }
        />
      </figcaption>
    </figure>
  )
}

const blocks = (chunks: number) => `${chunks * CHUNK_BLOCKS} blocks`

/** One line of the legend, with a swatch drawn in the map's own dither. */
function Key({ pattern, said }: { pattern: string; said: string }) {
  return (
    <span className={styles.key}>
      <svg width={14} height={14} viewBox="0 0 14 14" shapeRendering="crispEdges" aria-hidden>
        <rect
          x={0.75}
          y={0.75}
          width={12.5}
          height={12.5}
          fill={`url(#${pattern})`}
          className={styles.edge}
        />
      </svg>
      <span className="type-body-sm bk-num">{said}</span>
    </span>
  )
}
