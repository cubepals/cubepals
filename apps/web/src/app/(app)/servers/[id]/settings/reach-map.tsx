// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The view and simulation distances drawn to scale from above, with a legend in blocks. Only the
 * game form's numbers use it (`game-numbers.tsx`); it reads no settings of its own.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { useReducedMotion } from '../../../../../landing/hooks'
import { CHUNK_BLOCKS } from './load'
import styles from './reach.module.css'

/** The drawing's side and the room left round it, in CSS pixels: one unit is one pixel. */
const SIDE = 176
const EDGE = 4

/**
 * The world around one player, seen from above and drawn to scale while the owner slides: the
 * chunks they see, the chunks that keep moving inside them, and the player's own chunk at the
 * centre. Grey is a dither of Ink, as the brand draws depth, and the part that keeps moving
 * drifts slowly, one pixel at a time; the squares ease to each new distance. Both hold still for
 * someone who asked their device for less motion. The frame is the furthest distance
 * the page allows, so a full square is the most this server can have. The words beside it carry
 * what it shows; the drawing itself is hidden from screen readers.
 */
export function ReachMap({ view, simulation, max }: { view: number; simulation: number; max: number }) {
  const id = useId()
  const seen = `${id}-seen`
  const moving = `${id}-moving`
  const still = useReducedMotion()
  const moves = Math.min(view, simulation)
  const drawnView = useEased(view, still)
  const drawnMoves = useEased(moves, still)
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
          {/* A quarter Ink in diagonal lines, stepping sideways a pixel at a time. */}
          <pattern id={moving} width={DRIFT} height={DRIFT} patternUnits="userSpaceOnUse">
            {BANDS.map(([x, y]) => (
              <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} className={styles.ink} />
            ))}
            {!still && (
              <animateTransform
                attributeName="patternTransform"
                type="translate"
                values={Array.from({ length: DRIFT }, (_, i) => `${i} 0`).join(';')}
                dur={`${DRIFT * DRIFT_STEP_MS}ms`}
                calcMode="discrete"
                repeatCount="indefinite"
              />
            )}
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
        <rect {...square(drawnView)} fill={`url(#${seen})`} className={styles.edge} />
        <rect {...square(drawnMoves)} fill={`url(#${moving})`} className={styles.edge} />
        <rect {...square(0)} className={styles.player} />
      </svg>
      <figcaption className={styles.legend}>
        <span className={`${styles.title} type-eyebrow`}>Around each player</span>
        <Key pattern={seen} said={`They see ${blocks(view)} each way`} />
        <Key pattern={moving} said={`The world moves ${blocks(moves)} each way`} />
      </figcaption>
    </figure>
  )
}

/** The moving texture's tile, in pixels, and how long it rests on each pixel of its drift. */
const DRIFT = 4
const DRIFT_STEP_MS = 450
const BANDS = Array.from(
  { length: DRIFT * DRIFT },
  (_, i) => [i % DRIFT, Math.floor(i / DRIFT)] as const,
).filter(([x, y]) => (x + y) % DRIFT === 0)

/** How long a square takes to reach a new distance; it arrives with an out-quart, as things arrive here. */
const EASE_MS = 280
const outQuart = (t: number) => 1 - (1 - t) ** 4

/** `target` as drawn: eased from where it was to where it is now, or there at once when `still`. */
function useEased(target: number, still: boolean): number {
  const [drawn, setDrawn] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (still) {
      from.current = target
      setDrawn(target)
      return
    }
    const start = performance.now()
    const begin = from.current
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / EASE_MS)
      const value = begin + (target - begin) * outQuart(t)
      from.current = value
      setDrawn(value)
      if (t < 1) frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [target, still])
  return drawn
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
