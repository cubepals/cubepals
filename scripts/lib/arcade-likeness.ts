// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * No real person in the Arcade's world: what `arcade-world.ts` takes out of the maps once they are
 * placed, as console commands. The maps' player heads become skeleton skulls of the same shape,
 * since some are jumps in the courses. The statue of a player at the Jungle course's finish goes,
 * all of it, and a small pad where the last jumps land is the finish instead. The four figures in
 * the hub's display case under the balcony come out, leaving their plinths. The maps' armor
 * stands, item frames and other entities never come along, since cloning takes blocks only. Each change is in the map's credits (`maps.ts`).
 */
import type { Block } from '../../apps/control/src/minecraft/arcade/datapack.ts'
import { ARCADE_MAPS, placed } from '../../apps/control/src/minecraft/arcade/maps.ts'
import { JUNGLE_PAD } from '../../apps/control/src/minecraft/arcade/parkour.ts'

const fill = (from: Block, to: Block, block: string, replace?: string) =>
  `fill ${from.join(' ')} ${to.join(' ')} minecraft:${block}${replace === undefined ? '' : ` replace minecraft:${replace}`}`

/** Each map's player heads, standing and on walls, as skeleton skulls turned the same way. */
const HEADS = ARCADE_MAPS.flatMap((map) => {
  const [from, to] = [placed(map.key, map.from), placed(map.key, map.to)]
  return [
    ...Array.from({ length: 16 }, (_, r) =>
      fill(from, to, `skeleton_skull[rotation=${r}]`, `player_head[rotation=${r}]`),
    ),
    ...['north', 'south', 'east', 'west'].map((f) =>
      fill(from, to, `skeleton_wall_skull[facing=${f}]`, `player_wall_head[facing=${f}]`),
    ),
  ]
})

/**
 * The statue in the Jungle course, all of it: its legs and body, its shoulders, its head with its
 * face, and the ladders up it. The course's last jumps led onto its shoulder; they end on a small
 * mossy pad there now, which is the stage's finish (`JUNGLE_PAD`).
 */
const jungle = (b: Block) => placed('jungle', b)
const STATUE = [
  fill(jungle([-18, 0, -33]), jungle([-1, 32, -24]), 'air'),
  fill(jungle(JUNGLE_PAD.from), jungle(JUNGLE_PAD.to), 'mossy_stone_bricks'),
]

/**
 * The hub's display case: each figure, arms included, stands in a box of its own over the case's
 * carpet. Everything above the carpet goes, and where its feet stood is carpet like the rest.
 */
const FEET = [
  'gray_terracotta',
  'brown_terracotta',
  'black_concrete',
  'white_terracotta',
  'white_concrete',
  'brown_concrete',
  'pink_concrete',
  'pink_wool',
]
const FIGURES = [155, 166, 178, 189].flatMap((x0) => [
  fill([x0, 58, 1441], [x0 + 7, 71, 1447], 'air'),
  ...FEET.map((was) => fill([x0, 57, 1441], [x0 + 7, 57, 1447], 'orange_carpet', was)),
])

/** Run after the maps are placed and before the hall is recoloured, which reads the same blocks. */
export const LIKENESS_COMMANDS: readonly string[] = [...HEADS, ...STATUE, ...FIGURES]
