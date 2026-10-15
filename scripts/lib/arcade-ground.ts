// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ground the Arcade's hall is buried in, as console commands `arcade-world.ts` runs once the
 * maps are placed: the hall is underground, as the rooms are under the landing page's chunk
 * (`apps/web/src/landing/engine/chunk.ts`), and nothing of its shell shows. A crust of earth wraps
 * it on every side, layered as the chunk is: grass on top, a few blocks of dirt, stone, deepslate
 * and bedrock at the bottom, with ore here and there where its sides are seen. The house and its
 * garden stand on the grass (`arcade-house.ts`). Only air is filled, so nothing of the hall moves.
 */
import { hash3 } from '../../apps/web/src/landing/engine/world.ts'

type Block = readonly [number, number, number]

/** The hall's outside, both corners included: nothing of the build is beyond it. */
const HALL = { from: [102, 51, 1342], to: [254, 119, 1457] } as const

/** How far the crust reaches past the hall: its sides, its top (the grass), its bottom. */
export const GROUND = {
  from: [HALL.from[0] - 6, 44, HALL.from[2] - 6],
  to: [HALL.to[0] + 6, 121, 1470],
} as const

/** The grass's height, which the house's garden is level with. */
export const SURFACE = GROUND.to[1]

/** Each layer by its heights, top down, as the landing page's chunk has them. */
const LAYERS: ReadonlyArray<{ block: string; ys: [number, number] }> = [
  { block: 'grass_block', ys: [SURFACE, SURFACE] },
  { block: 'dirt', ys: [SURFACE - 4, SURFACE - 1] },
  { block: 'stone', ys: [60, SURFACE - 5] },
  { block: 'deepslate', ys: [GROUND.from[1] + 1, 59] },
  { block: 'bedrock', ys: [GROUND.from[1], GROUND.from[1]] },
]

/**
 * The crust as boxes: a slab on each side, the length of the hall and more, one over it, one under
 * it. Where they overlap, filling only air makes no difference.
 */
function slabs(): Array<[Block, Block]> {
  const [x0, y0, z0] = GROUND.from
  const [x1, y1, z1] = GROUND.to
  const [hx0, hy0, hz0] = HALL.from
  const [hx1, hy1, hz1] = HALL.to
  return [
    [
      [x0, y0, z0],
      [hx0 - 1, y1, z1],
    ],
    [
      [hx1 + 1, y0, z0],
      [x1, y1, z1],
    ],
    [
      [hx0, y0, z0],
      [hx1, y1, hz0 - 1],
    ],
    [
      [hx0, y0, hz1 + 1],
      [hx1, y1, z1],
    ],
    [
      [hx0, hy1 + 1, hz0],
      [hx1, y1, hz1],
    ],
    [
      [hx0, y0, hz0],
      [hx1, hy0 - 1, hz1],
    ],
  ]
}

const fill = (from: Block, to: Block, block: string, mode = 'keep') =>
  `fill ${from.join(' ')} ${to.join(' ')} minecraft:${block} ${mode}`

/** Each slab, layer by layer, in air only. */
const LAYER_COMMANDS = slabs().flatMap(([from, to]) =>
  LAYERS.flatMap(({ block, ys }) => {
    const [lo, hi] = [Math.max(ys[0], from[1]), Math.min(ys[1], to[1])]
    return lo > hi ? [] : [fill([from[0], lo, from[2]], [to[0], hi, to[2]], block)]
  }),
)

/** Every block of the crust's four outer faces: the ones a player sees from the garden's edge. */
function faces(): Block[] {
  const [x0, y0, z0] = GROUND.from
  const [x1, y1, z1] = GROUND.to
  const out: Block[] = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x <= x1; x++) out.push([x, y, z0], [x, y, z1])
    for (let z = z0 + 1; z < z1; z++) out.push([x0, y, z], [x1, y, z])
  }
  return out
}

/**
 * The faces' grain, by the landing page's own hash: dirt a block deeper here and there, deepslate
 * a block higher, and ore one block in seventy. Set over the layers, in place.
 */
function grain([x, y, z]: Block): string | null {
  const r = hash3(x, y, z)
  if (y === SURFACE - 5 && r > 0.6) return 'dirt'
  if (y === 60 && r > 0.5) return 'deepslate'
  if (y > 60 && y < SURFACE - 5 && r > 0.985) return 'coal_ore'
  if (y > GROUND.from[1] && y < 60 && r > 0.988) return 'deepslate_coal_ore'
  return null
}

const GRAIN_COMMANDS = faces().flatMap((at) => {
  const block = grain(at)
  return block === null ? [] : [`setblock ${at.join(' ')} minecraft:${block}`]
})

export const GROUND_COMMANDS: readonly string[] = [...LAYER_COMMANDS, ...GRAIN_COMMANDS]
