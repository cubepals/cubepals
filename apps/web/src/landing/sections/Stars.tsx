// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The night sky's stars: a few squares at fixed places, each going out at its own moment as the
 * day comes.
 */
import type { CSSProperties } from 'react'

/** A few stars, a pixel each, at fixed places so the server and the browser draw the same sky. */
const STARS: [number, number, number][] = [
  [4, 12, 2],
  [9, 31, 1],
  [14, 7, 1],
  [21, 22, 2],
  [27, 4, 1],
  [33, 16, 1],
  [38, 9, 2],
  [46, 26, 1],
  [52, 5, 1],
  [58, 14, 2],
  [63, 30, 1],
  [69, 8, 1],
  [74, 19, 2],
  [81, 3, 1],
  [86, 24, 1],
  [92, 11, 2],
  [97, 28, 1],
  [12, 44, 1],
  [48, 40, 1],
  [88, 42, 1],
]

/**
 * The night sky's stars, stretched over whatever they are put in. Each goes out at its own moment
 * as the day comes, and twinkles in its own time while it is dark (landing.css, `.bl-stars`).
 */
export function Stars({ className }: { className?: string }) {
  return (
    <svg
      className={className ? `bl-stars ${className}` : 'bl-stars'}
      viewBox="0 0 100 56"
      preserveAspectRatio="none"
      aria-hidden
    >
      {STARS.map(([x, y, size], index) => (
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width={size * 0.14}
          height={size * 0.25}
          fill="currentColor"
          style={
            {
              // The low ones go first, as they do; no two twinkle together.
              '--at': (0.18 + (1 - y / 46) * 0.5 + ((index * 7) % 5) * 0.03).toFixed(2),
              '--after': `${((index * 37) % 23) / 4}s`,
              '--every': `${3.6 + ((index * 13) % 7) * 0.6}s`,
            } as CSSProperties
          }
        />
      ))}
    </svg>
  )
}
