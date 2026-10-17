// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals in the Arcade's world, as `arcade-world.ts` builds it: the mark in blocks on the hall's
 * two arcade screens, Ink on the lit one and Paper on Ink on the other, the brand's two
 * colourways (`brand/README.md`), and the games' pads. Not the maps or the games, nor the Cubepals
 * signs, which the datapack builds (`minecraft/arcade/signs.ts`).
 *
 * The brand's files are Cubepals' own, not the repository's licence (`brand/LICENSE.md`). In the
 * hub, NetherGames' CC BY 4.0 map, the mark is built in blocks.
 */
import type { Block } from '../../apps/control/src/minecraft/arcade/datapack.ts'
import { FLOOR_PAD } from '../../apps/control/src/minecraft/arcade/floor.ts'
import { PADS } from '../../apps/control/src/minecraft/arcade/hub.ts'

/**
 * The mark at eleven blocks square, drawn rather than scaled down: a square, two circles and the
 * square with its S-curve bite, each five blocks with a block between them, as a viewer sees it.
 */
const MARK = [
  '#####..###.',
  '#####.#####',
  '#####.#####',
  '#####.#####',
  '#####..###.',
  '...........',
  '.###..##...',
  '#####.###..',
  '#####.#####',
  '#####.#####',
  '.###..#####',
]

/**
 * The mark drawn on a screen: `left` is the block at the viewer's top left, and `right` the
 * direction the viewer's right is along x (+1 or -1). Only the mark's own blocks are set.
 */
function mark(left: readonly [number, number, number], right: 1 | -1, block: string): string[] {
  const [x, y, z] = left
  return MARK.flatMap((row, r) =>
    [...row].flatMap((cell, c) =>
      cell === '#' ? [`setblock ${x + c * right} ${y - r} ${z} minecraft:${block}`] : [],
    ),
  )
}

/** A game's pad: Ink, three blocks square, in a ring of Paper, as the datapack finds it by its middle. */
const pad = ([x, y, z]: Block): string[] => [
  `fill ${x - 2} ${y} ${z - 2} ${x + 2} ${y} ${z + 2} minecraft:quartz_block`,
  `fill ${x - 1} ${y} ${z - 1} ${x + 1} ${y} ${z + 1} minecraft:black_concrete`,
]

/**
 * The hall's two screens and the pads. The big ARCADE cabinet on the north wall faces the hall:
 * its glowing screen loses NetherGames' letters and shows the mark in Ink. The screen over the
 * entrance faces the other way: its letters come off the front, its back turns Ink, and the mark
 * is Paper. Then each game's pad, on the balcony and at the falling floor's lake.
 */
export const BRAND_COMMANDS: readonly string[] = [
  'fill 166 75 1354 185 87 1354 minecraft:sea_lantern replace minecraft:yellow_concrete',
  'fill 166 75 1354 185 87 1354 minecraft:sea_lantern replace minecraft:orange_concrete',
  ...mark([170, 86, 1354], 1, 'black_concrete'),
  'fill 169 84 1446 182 96 1446 minecraft:air replace minecraft:orange_concrete',
  'fill 170 85 1447 181 95 1447 minecraft:black_concrete',
  'fill 169 84 1447 182 96 1447 minecraft:black_concrete replace minecraft:nether_brick_stairs',
  ...mark([180, 95, 1446], -1, 'quartz_block'),
  ...[...PADS.map((p) => p.middle), FLOOR_PAD].flatMap(pad),
]
