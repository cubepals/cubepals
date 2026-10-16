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
} from '../apps/control/src/minecraft/arcade/label-space.ts'
import { ARCADE_WORLD } from '../apps/control/src/minecraft/arcade/maps.ts'
import { ARCADE_LABELS } from '../apps/control/src/minecraft/arcade.ts'
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

/** The farthest a room may reach to either side of its middle, at its place and height, with nothing in it. */
function reach(room: Room): number {
  const widest = { ...room, width: 2 * FURTHEST }
  const [from, to] = roomBox(widest)
  const solid = [...blocksIn(world, from, to)]
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
  }))

rmSync(world, { recursive: true, force: true })
writeFileSync(OUT, `${JSON.stringify({ world: ARCADE_WORLD.sha512, rooms }, null, 2)}\n`)
for (const room of rooms) process.stdout.write(`${room.at.join(' ')}: reaches ${room.reach} either side\n`)
process.stdout.write(`${OUT}: ${rooms.length} rooms measured\n`)
