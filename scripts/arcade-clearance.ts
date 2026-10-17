// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Measures, in the Arcade's world, how much room each label and marker the datapack makes has
 * clear of blocks, and writes it for `arcade.test.ts` to hold every label to
 * (`apps/control/src/minecraft/arcade/clearance.json`):
 *
 *     bun scripts/arcade-clearance.ts [archive]
 *
 * `archive` is the world as `ARCADE_WORLD` names it, by its very bytes: the one
 * `scripts/arcade-world.ts` packs (`local/arcade-world/arcade-world.tar.gz`, the default), or the
 * copy in a deployment's archive store. Run it again when a label or marker moves, or the world
 * changes. It writes measurements alone, never a block of the maps, which stay out of this
 * repository: for each label, at its place and over its height, how far it could reach to either
 * side of its middle before it met a block.
 *
 * What a player can't see or touch doesn't count: the hall's light blocks, barriers.
 *
 * A label or marker flat on a wall also has the wall's face measured, around it: each block behind
 * it that is a solid, opaque, whole block with nothing in front of it, so that none of it hangs off
 * the wall's edge, over a window or behind a block standing out. The world is read as the datapack
 * leaves it once it has built, its own blocks (`fill` and `setblock`) laid over the archive's.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_MARKERS } from '../apps/control/src/minecraft/arcade/hub.ts'
import {
  inRoom,
  markerRoom,
  type Room,
  roomBox,
  roomOf,
  wallOf,
} from '../apps/control/src/minecraft/arcade/label-space.ts'
import { ARCADE_WORLD } from '../apps/control/src/minecraft/arcade/maps.ts'
import { ARCADE_FILES, ARCADE_LABELS, ARCADE_READS } from '../apps/control/src/minecraft/arcade.ts'
import type { Read } from '../apps/control/src/minecraft/readable.ts'
import { cornersOf } from '../apps/control/src/minecraft/sight.ts'
import { blocksSet, laidOver } from './lib/build-blocks.ts'
import { blocksIn } from './lib/region-blocks.ts'

const OUT = 'apps/control/src/minecraft/arcade/clearance.json'
const UNSEEN = new Set(['minecraft:light', 'minecraft:barrier', 'minecraft:structure_void'])
/** The widest reach measured: a label wider than this is not one to measure. */
const FURTHEST = 12

const archive = process.argv[2] ?? 'local/arcade-world/arcade-world.tar.gz'
if (createHash('sha512').update(readFileSync(archive)).digest('hex') !== ARCADE_WORLD.sha512)
  throw new Error(`${archive} is not the archive ARCADE_WORLD names`)
const world = mkdtempSync(join(tmpdir(), 'arcade-clearance-'))
if (spawnSync('tar', ['-xzf', archive, '-C', world], { stdio: 'inherit' }).status !== 0)
  throw new Error(`${archive} would not unpack`)

/** The datapack's own blocks, by place, as its build leaves them. */
const built = blocksSet(
  (ARCADE_FILES.find((file) => file.path.endsWith('/function/build.mcfunction'))?.content ?? '').split('\n'),
)

/** The blocks in a box, as the world has them once the datapack has built: air left out. */
const blocksBuilt = (from: [number, number, number], to: [number, number, number]) =>
  laidOver(blocksIn(world, from, to), built, from, to)

/** Blocks that aren't a solid, opaque, whole block, which a label on them would hang over or show through. */
const NOT_WALL =
  /slab|stairs|pane|glass|fence|_wall|wall_|door|carpet|button|lever|torch|lantern(?<!sea_lantern)|chain|rail|sign|banner|flower|sapling|^minecraft:light$|barrier|bars|ladder|vine|plate|leaves|candle|head|skull|pot|frame|scaffolding|bed|chest|anvil|hopper|cauldron|campfire|_rod|grass$|fern|bush|cobweb|water|lava|snow$/

/**
 * The face of the wall a flat room is on, around it, a row to each block's height, top first, and a
 * block to each place along it, the lowest first: '#' where the block behind is a whole, solid block
 * with nothing in front, '.' where it isn't.
 */
function faceOf(room: Room): { from: number; top: number; rows: string[] } | undefined {
  const on = wallOf(room)
  if (on === null) return undefined
  const [from, to] = [Math.floor(on.mid - room.width / 2) - 2, Math.floor(on.mid + room.width / 2) + 2]
  const [bottom, top] = [Math.floor(room.at[1]) - 1, Math.floor(room.at[1] + room.height) + 1]
  const place = (along: number, y: number, depth: number): [number, number, number] =>
    on.across === 'x' ? [along, y, depth] : [depth, y, along]
  const [lo, hi] = [Math.min(on.wall, on.front), Math.max(on.wall, on.front)]
  const blocks = blocksBuilt(place(from, bottom, lo), place(to, top, hi))
  const at = (along: number, y: number, depth: number) => blocks.get(place(along, y, depth).join(' '))
  const rows: string[] = []
  for (let y = top; y >= bottom; y--) {
    let row = ''
    for (let along = from; along <= to; along++) {
      const [behind, before] = [at(along, y, on.wall), at(along, y, on.front)]
      const clear = before === undefined || UNSEEN.has(before)
      row += clear && behind !== undefined && !NOT_WALL.test(behind) ? '#' : '.'
    }
    rows.push(row)
  }
  return { from, top, rows }
}

/** The farthest a room may reach to either side of its middle, at its place and height, with nothing in it. */
function reach(room: Room): number {
  const widest = { ...room, width: 2 * FURTHEST }
  const [from, to] = roomBox(widest)
  const solid = [...blocksBuilt(from, to)]
    .filter(([, block]) => !UNSEEN.has(block))
    .map(([at]) => at.split(' ').map(Number) as [number, number, number])
  let [clear, blocked] = [0, FURTHEST]
  if (!solid.some((block) => inRoom(widest, block))) return FURTHEST
  // Halving the gap down to a thousandth of a block.
  while (blocked - clear > 0.001) {
    const half = (clear + blocked) / 2
    if (solid.some((block) => inRoom({ ...room, width: 2 * half }, block))) blocked = half
    else clear = half
  }
  return Math.floor(clear * 1000) / 1000
}

// Each measured over its height to the thousandth above, which is what is written.
const rooms = [...ARCADE_LABELS.map(roomOf), ...HUB_MARKERS.map(markerRoom)]
  .map((room) => ({ ...room, height: Math.ceil(room.height * 1000) / 1000 }))
  .map((room) => ({
    at: room.at,
    height: room.height,
    ...(room.flat === undefined ? {} : { facing: room.flat.facing }),
    reach: reach(room),
    ...(faceOf(room) === undefined ? {} : { face: faceOf(room) }),
  }))

/** Blocks a player sees through: what isn't there, light, barriers, glass and water. */
const SEE_THROUGH = /(^|:)(air|cave_air|void_air|light|barrier|structure_void|water)$|glass/

/**
 * How much of a label is hidden from where it is first read: rays from the eye to points across
 * its plate, seven along and three up, a little in from its edges, each marched a twentieth of a
 * block at a time; a ray is hidden where it meets a block a player can't see through.
 */
function hidden({ label, from }: Read): { at: readonly number[]; hidden: number; rays: number } {
  const [topLeft, topRight, , bottomLeft] = cornersOf(label, from.eye)
  if (topLeft === undefined || topRight === undefined || bottomLeft === undefined)
    throw new Error('A plate has four corners')
  type Point = [number, number, number]
  const along = (k: number) => topRight[k] ?? 0
  /** The point `u` of the way along the plate from its left and `v` of the way up from its foot. */
  const on = (u: number, v: number): Point => {
    const at = (k: 0 | 1 | 2) =>
      (bottomLeft[k] ?? 0) +
      (along(k) - (topLeft[k] ?? 0)) * u +
      ((topLeft[k] ?? 0) - (bottomLeft[k] ?? 0)) * v
    return [at(0), at(1), at(2)]
  }
  const points: Point[] = []
  for (let i = 0; i < 7; i++)
    for (let j = 0; j < 3; j++) points.push(on(0.04 + (0.92 * i) / 6, 0.08 + (0.84 * j) / 2))
  const eye = from.eye
  const bound = (pick: (...values: number[]) => number) =>
    [0, 1, 2].map((k) => Math.floor(pick(eye[k] ?? 0, ...points.map((point) => point[k] ?? 0)))) as Point
  const blocks = blocksBuilt(bound(Math.min), bound(Math.max))
  const blocked = points.filter((point) => {
    const steps = Math.ceil(Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]) / 0.05)
    for (let step = 1; step < steps; step++) {
      const t = step / steps
      const cell = [0, 1, 2].map((k) => Math.floor((eye[k] ?? 0) + ((point[k] ?? 0) - (eye[k] ?? 0)) * t))
      const block = blocks.get(cell.join(' '))
      if (block !== undefined && !SEE_THROUGH.test(block)) return true
    }
    return false
  })
  return { at: label.at, hidden: blocked.length, rays: points.length }
}
const sight = ARCADE_READS.map(hidden)

rmSync(world, { recursive: true, force: true })
writeFileSync(OUT, `${JSON.stringify({ world: ARCADE_WORLD.sha512, rooms, sight }, null, 2)}\n`)
// Written as the repository's formatter writes JSON, so lint passes on it as it is.
if (spawnSync('bunx', ['biome', 'format', '--write', OUT], { stdio: 'inherit' }).status !== 0)
  throw new Error(`${OUT} would not format`)
for (const room of rooms) process.stdout.write(`${room.at.join(' ')}: reaches ${room.reach} either side\n`)
for (const seen of sight)
  process.stdout.write(`${seen.at.join(' ')}: ${seen.hidden} of ${seen.rays} rays hidden\n`)
process.stdout.write(`${OUT}: ${rooms.length} rooms measured\n`)
