// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The house from cubepals.com's landing page, outside the Arcade's hall, where everyone starts:
 * the landing page's own chunk (`apps/web/src/landing/engine/chunk.ts`), read cell by cell, its
 * surface and the house on it as they are, each kind of block as the block that looks like it, by
 * eye against the page. Beneath the grass, the chunk goes down sixteen blocks of its own earth and
 * stone; the rooms the page digs under it stay on the page. It floats outside the hall's south
 * wall, turned so its path runs from the door straight into the west corridor (`arcade-hall.ts`).
 *
 * The house is Cubepals' own, as the landing page is, and is under none of the maps' licences.
 */
import { buildChunk, SIZE } from '../../apps/web/src/landing/engine/chunk.ts'
import { Kind } from '../../apps/web/src/landing/engine/world.ts'
import { DOORWAY } from './arcade-hall.ts'

/** How deep the island goes below its grass. */
const DEPTH = 16

/**
 * Where a cell of the chunk goes in the world. The chunk's +x, the way its path runs from the door,
 * is north toward the hall; its +z is east. The path's last cell is just outside the doorway, and
 * the grass level with the corridor's floor.
 */
const PATH_Z = 4
const [doorX, floorY, wallZ] = [DOORWAY.from[0] + 1, DOORWAY.from[1] - 1, DOORWAY.to[2]]
const at = (x: number, y: number, z: number): [number, number, number] => [
  doorX - PATH_Z + z,
  floorY + y,
  wallZ + SIZE - x,
]

/** The chunk's +z and −z, as the world's ways: what a roof stair faces, rising toward the ridge. */
const RISING = { toward: 'east', away: 'west' } as const

/** Each kind as a block, by eye: the page prints planks palest, the roof a middle grey, the door dark. */
const BLOCKS: Partial<Record<number, string>> = {
  [Kind.grass]: 'grass_block',
  [Kind.dirt]: 'dirt',
  [Kind.stone]: 'stone',
  [Kind.deepslate]: 'deepslate',
  [Kind.ore]: 'coal_ore',
  [Kind.log]: 'spruce_log',
  [Kind.leaves]: 'oak_leaves[persistent=true]',
  [Kind.planks]: 'birch_planks',
  [Kind.cobble]: 'cobblestone',
  [Kind.water]: 'water',
  [Kind.path]: 'dirt_path',
  [Kind.glass]: 'glass',
  [Kind.lamp]: 'lantern',
  [Kind.sand]: 'sand',
  [Kind.torch]: 'torch',
}

/** The page's house is block by block; under the grass, a room the page digs is earth here. */
function blockAt(world: ReturnType<typeof buildChunk>, x: number, y: number, z: number): string | null {
  const kind = world.get(x, y, z)
  if (kind === Kind.roof) return `stone_brick_stairs[facing=${z <= 4 ? RISING.toward : RISING.away}]`
  if (kind === Kind.dark)
    return `dark_oak_door[facing=north,half=${world.get(x, y - 1, z) === Kind.dark ? 'upper' : 'lower'}]`
  if (kind === Kind.air) return y < 0 ? (y >= -3 ? 'dirt' : 'stone') : null
  return BLOCKS[kind] ?? 'stone'
}

const world = buildChunk()
const cells: string[] = []
for (let y = -DEPTH; y < world.top; y++)
  for (let z = 0; z < SIZE; z++)
    for (let x = 0; x < SIZE; x++) {
      const block = blockAt(world, x, y, z)
      if (block !== null) cells.push(`setblock ${at(x, y, z).join(' ')} minecraft:${block}`)
    }

/** The page's lights in the house, as light blocks where they hang: they light its inside. */
const lights = world.lights
  .filter((light) => light.y >= 0 && light.y < world.top)
  .map(
    (light) =>
      `setblock ${at(Math.floor(light.x), Math.floor(light.y), Math.floor(light.z)).join(' ')} minecraft:light[level=15] keep`,
  )

/** Where a player stands inside, facing the door, as the hub's spawn says it (`HUB_SPAWN`). */
export const INSIDE = at(4, 1, PATH_Z)

export const HOUSE_COMMANDS: readonly string[] = [...cells, ...lights]
