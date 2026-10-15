// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The house from cubepals.com's landing page, where everyone starts, and the way down from it to
 * the Arcade's hall: the landing page's own chunk (`apps/web/src/landing/engine/chunk.ts`), its
 * surface and everything on it as they are (the house, its trees, the pond, the path, the lamp and
 * the signpost), laid on the grass over the buried hall (`arcade-ground.ts`), each kind of block as
 * the block that looks like it, by eye against the page. The chunk's own rooms stay on the page:
 * the hall is the dig here. The rest of the grass is a meadow, with the page's tree standing here
 * and there on it.
 *
 * Inside, the page draws nothing but its light, so the house is furnished simply (a bed, a table,
 * a shelf with a lamp, a rug, a lantern overhead) round a staircase in the floor. The stairs run
 * down through the ground, lit, to the doorway at the end of the hall's west corridor
 * (`arcade-hall.ts`).
 *
 * The house is Cubepals' own, as the landing page is, and is under none of the maps' licences.
 */
import { buildChunk } from '../../apps/web/src/landing/engine/chunk.ts'
import { hash3, Kind } from '../../apps/web/src/landing/engine/world.ts'
import { GROUND, SURFACE } from './arcade-ground.ts'
import { DOORWAY } from './arcade-hall.ts'

type Block = [number, number, number]

/**
 * The staircase: two wide, one step up for each block east, from the doorway's floor to the
 * house's. Its last step is level with the floor, so the three before it are a hole in the floor.
 */
const DOOR_FLOOR = DOORWAY.from[1] - 1
const STEPS = SURFACE - DOOR_FLOOR
const LANE = [DOORWAY.to[2] + 3, DOORWAY.to[2] + 4] as const
const step = (i: number): Block => [DOORWAY.to[0] + i, DOOR_FLOOR + i, LANE[0]]

/**
 * Where a cell of the chunk goes in the world: its +x, the way the door and the path face, is
 * east; its +z is south. The house's back corner, two cells in, holds the top of the stairs.
 */
const [OX, OZ] = [step(STEPS)[0] - 6, LANE[0] - 5]
const at = (x: number, y: number, z: number): Block => [OX + x, SURFACE + y, OZ + z]

/** Each kind as a block, by eye: the page prints planks palest, the roof a middle grey, the door dark. */
const BLOCKS: Partial<Record<number, string>> = {
  [Kind.grass]: 'grass_block',
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

const world = buildChunk()

/** The page's surface and what stands on it; its roof's stairs rise toward the ridge. */
function blockAt(x: number, y: number, z: number): string | null {
  const kind = world.get(x, y, z)
  if (kind === Kind.roof) return `stone_brick_stairs[facing=${z <= 4 ? 'south' : 'north'}]`
  if (kind === Kind.dark)
    return `dark_oak_door[facing=west,half=${world.get(x, y - 1, z) === Kind.dark ? 'upper' : 'lower'}]`
  if (kind === Kind.air) return null
  return BLOCKS[kind] ?? 'stone'
}

const set = ([x, y, z]: Block, block: string) => `setblock ${x} ${y} ${z} minecraft:${block}`
const fill = ([x0, y0, z0]: Block, [x1, y1, z1]: Block, block: string) =>
  `fill ${x0} ${y0} ${z0} ${x1} ${y1} ${z1} minecraft:${block}`

const surface: string[] = []
for (let y = 0; y < world.top; y++)
  for (let z = 0; z < 16; z++)
    for (let x = 0; x < 16; x++) {
      const block = blockAt(x, y, z)
      if (block !== null) surface.push(set(at(x, y, z), block))
    }

/** The page's lights, as light blocks where they hang. */
const lights = world.lights
  .filter((light) => light.y >= 0 && light.y < world.top)
  .map(
    (light) =>
      `${set(at(Math.floor(light.x), Math.floor(light.y), Math.floor(light.z)), 'light[level=15]')} keep`,
  )

/** The staircase's walls, floor and ceiling in stone brick, under the grass; then its air and steps. */
const [landingFrom, landingTo]: [Block, Block] = [
  [DOORWAY.from[0], DOOR_FLOOR, DOORWAY.to[2] + 1],
  [DOORWAY.to[0], DOOR_FLOOR + 3, LANE[1]],
]
const stairs: string[] = [
  fill(
    [landingFrom[0] - 1, DOOR_FLOOR - 1, landingFrom[2]],
    [landingTo[0], DOOR_FLOOR + 4, LANE[1] + 1],
    'stone_bricks',
  ),
  fill([landingFrom[0], DOOR_FLOOR + 1, landingFrom[2]], landingTo, 'air'),
]
const steps: string[] = []
for (let i = 1; i <= STEPS; i++) {
  const [x, y] = step(i)
  stairs.push(fill([x, y - 1, LANE[0] - 1], [x, Math.min(y + 4, SURFACE - 1), LANE[1] + 1], 'stone_bricks'))
  steps.push(
    fill([x, y + 1, LANE[0]], [x, y + 3, LANE[1]], 'air'),
    fill([x, y, LANE[0]], [x, y, LANE[1]], 'stone_brick_stairs[facing=east]'),
  )
  // A lantern every six steps, hung from the ceiling, over the walker's head.
  if (i % 6 === 3 && y + 4 < SURFACE) steps.push(set([x, y + 3, LANE[0]], 'lantern[hanging=true]'))
}

/** Inside the house, in the chunk's cells: its floor, then what stands on it. */
const furnishing: string[] = [
  // Planks under the whole house, walls too, so the stairs' hole shows wood at its edges.
  fill(at(2, 0, 2), at(7, 0, 7), 'spruce_planks'),
  set(at(3, 1, 3), 'yellow_bed[facing=west,part=head]'),
  set(at(4, 1, 3), 'yellow_bed[facing=west,part=foot]'),
  set(at(5, 1, 3), 'spruce_fence'),
  set(at(5, 2, 3), 'spruce_pressure_plate'),
  set(at(6, 1, 3), 'bookshelf'),
  set(at(6, 2, 3), 'lantern'),
  fill(at(3, 1, 4), at(5, 1, 4), 'white_carpet'),
  set(at(4, 5, 4), 'chain[axis=y]'),
  set(at(4, 4, 4), 'lantern[hanging=true]'),
]

/**
 * The page's tree round the garden: a trunk four or five high, three layers of leaves two out from
 * it with the corners cut, and one on top one out. One every sixteen blocks or so, placed by the
 * landing page's own hash, and none on the garden or by the grass's edge.
 */
function tree(x: number, z: number): string[] {
  const height = hash3(x, 0, z) > 0.5 ? 5 : 4
  const base = SURFACE + 1
  const out = [fill([x, base, z], [x, base + height - 1, z], 'spruce_log')]
  for (let dy = 0; dy <= 3; dy++) {
    const reach = dy === 3 ? 1 : 2
    const y = base + height - 2 + dy
    for (let dz = -reach; dz <= reach; dz++)
      for (let dx = -reach; dx <= reach; dx++)
        if (leafy(x + dx, z + dz, dx, dy, dz, reach))
          out.push(`${set([x + dx, y, z + dz], 'oak_leaves[persistent=true]')} keep`)
  }
  return out
}

/** Whether a tree's layer has a leaf there: not at its corners but some on the second, nor in its trunk. */
function leafy(x: number, z: number, dx: number, dy: number, dz: number, reach: number): boolean {
  const corner = Math.abs(dx) === reach && Math.abs(dz) === reach
  if (corner) return dy === 1 && hash3(x, dy, z) <= 0.4
  return !(dx === 0 && dz === 0 && dy < 2)
}

const GARDEN = { from: at(-4, 0, -4), to: at(19, 0, 19) }
const meadow: string[] = []
for (let gx = GROUND.from[0] + 6; gx <= GROUND.to[0] - 6; gx += 16)
  for (let gz = GROUND.from[2] + 6; gz <= GROUND.to[2] - 6; gz += 16) {
    const [x, z] = [gx + Math.floor(hash3(gx, 1, gz) * 8) - 4, gz + Math.floor(hash3(gx, 2, gz) * 8) - 4]
    const onGarden = x >= GARDEN.from[0] && x <= GARDEN.to[0] && z >= GARDEN.from[2] && z <= GARDEN.to[2]
    if (!onGarden && hash3(gx, 3, gz) > 0.35) meadow.push(...tree(x, z))
  }

/** Where a player stands inside, on the rug by the stairs, as the hub's spawn says it (`HUB_SPAWN`). */
export const INSIDE = at(5, 1, 4)

/** The top step, where the hub's sign saying where the stairs go stands (`STAIRS_TOP` in `hub.ts`). */
export const STAIRS_TOP = at(6, 0, 5)

export const HOUSE_COMMANDS: readonly string[] = [
  ...stairs,
  ...surface,
  ...furnishing,
  ...steps,
  ...lights,
  ...meadow,
]
