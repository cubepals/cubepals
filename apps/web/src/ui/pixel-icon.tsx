// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Small pictures drawn in the game's pixels, 12 by 12, in the text's own colour: the plan cards'
 * lines and their details' chevron. Each is written as its rows, `#` for a pixel, and drawn with
 * square edges at any size. Not for the product's interface icons, which are Lucide's (`ICON`).
 */
const ICONS = {
  friends: [
    '............',
    '.###...###..',
    '.###...###..',
    '.###...###..',
    '............',
    '#####.#####.',
    '#####.#####.',
    '#####.#####.',
    '#####.#####.',
  ],
  crowd: [
    '............',
    '.##..##..##.',
    '.##..##..##.',
    '............',
    '###.####.###',
    '###.####.###',
    '###.####.###',
    '###.####.###',
  ],
  bridge: [
    '............',
    '............',
    '####....####',
    '#..#....#..#',
    '#..######..#',
    '#..######..#',
    '#..#....#..#',
    '####....####',
  ],
  moon: [
    '....####....',
    '..####......',
    '.###........',
    '.##.........',
    '###.........',
    '###.........',
    '###.........',
    '.##.......#.',
    '.###.....##.',
    '..########..',
    '....####....',
  ],
  chest: [
    '............',
    '.##########.',
    '.#........#.',
    '.##########.',
    '.#...##...#.',
    '.#...##...#.',
    '.#........#.',
    '.##########.',
  ],
  servers: [
    '.##########.',
    '.#.##.....#.',
    '.##########.',
    '............',
    '.##########.',
    '.#.##.....#.',
    '.##########.',
    '............',
    '.##########.',
    '.#.##.....#.',
    '.##########.',
  ],
  anvil: [
    '............',
    '.#########..',
    '############',
    '.#########..',
    '....####....',
    '....####....',
    '...######...',
    '..########..',
    '..########..',
  ],
  chevron: [
    '............',
    '............',
    '............',
    '.##......##.',
    '..##....##..',
    '...##..##...',
    '....####....',
    '.....##.....',
  ],
} as const satisfies Record<string, readonly string[]>

export type PixelIconName = keyof typeof ICONS

/** The rows as one path: each run of pixels in a row is one rectangle. */
const pathOf = (rows: readonly string[]) =>
  rows
    .flatMap((row, y) =>
      [...row.matchAll(/#+/g)].map((run) => `M${run.index ?? 0} ${y}h${run[0].length}v1h-${run[0].length}z`),
    )
    .join('')

export function PixelIcon({
  name,
  size = 28,
  className,
}: {
  name: PixelIconName
  /** Its width and height in CSS pixels. */
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d={pathOf(ICONS[name])} />
    </svg>
  )
}
