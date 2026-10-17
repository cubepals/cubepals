// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Works out where players play on Cubepals' own servers, and writes it for the tests to keep every
 * Cubepals sign, frame, light and label out of (`play-space.json.gz`, which `play-space.test.ts` reads):
 *
 *     bun scripts/play-space.ts [archive]
 *
 * `archive` is the Arcade's world as `ARCADE_WORLD` names it, by its very bytes, as
 * `scripts/arcade-clearance.ts` takes it. The Arcade is read as its datapack leaves it, the maps'
 * blocks with the datapack's own laid over them, its signs left out; Duels as its waiting datapack
 * builds beside the void world's platform, its sign left out. A published course or arena is room
 * all through, every block of it a place a jump may land: the parkour's three courses, the
 * market and the falling floor's floors. Everywhere else, from every place a game puts a player
 * (spawns, arrivals, pads, machines), it walks where a player can go (`lib/play-reach.ts`). It
 * writes that room as boxes. It writes no block of the maps, which stay
 * out of this repository. Run it again when a game's places, the build or the world change.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { HUB_SPAWN } from '../apps/control/src/minecraft/arcade/datapack.ts'
import { FLOOR_ARRIVAL, FLOOR_DISC } from '../apps/control/src/minecraft/arcade/floor.ts'
import { PASSAGE } from '../apps/control/src/minecraft/arcade/hub.ts'
import { MACHINES } from '../apps/control/src/minecraft/arcade/machines.ts'
import { ARCADE_MAPS, ARCADE_WORLD, placed } from '../apps/control/src/minecraft/arcade/maps.ts'
import { buildSign } from '../apps/control/src/minecraft/arcade/signs.ts'
import { GAMES } from '../apps/control/src/minecraft/arcade/ways-in.ts'
import { ARCADE_FILES, ARCADE_SIGNS } from '../apps/control/src/minecraft/arcade.ts'
import {
  DUELS_PLACES,
  DUELS_SIGN_COMMANDS,
  WAITING_FILES,
} from '../apps/control/src/minecraft/duels-waiting.ts'
import { blocksSet, laidOver } from './lib/build-blocks.ts'
import { HEADROOM, playRoom, type RoomBox, roomBoxes } from './lib/play-reach.ts'
import { blocksIn } from './lib/region-blocks.ts'

type Block = readonly [number, number, number]

const OUT = 'scripts/play-space.json.gz'

/** A place as a command gives it, `x y z yaw pitch`, as the block a player stands in. */
const blockOf = (place: string): Block => {
  const [x = 0, y = 0, z = 0] = place.split(' ').map(Number)
  return [Math.floor(x), Math.floor(y), Math.floor(z)]
}
/** A datapack's build, without the commands that build its signs. */
const buildOf = (files: readonly { path: string; content: string }[], signs: ReadonlySet<string>) =>
  (files.find((file) => file.path.endsWith('/function/build.mcfunction'))?.content ?? '')
    .split('\n')
    .filter((command) => !signs.has(command))

/** One game's room: a box of the world, read once, and where the game puts players in it. */
function roomIn(
  read: (from: Block, to: Block) => Map<string, string>,
  from: Block,
  to: Block,
  seeds: Block[],
) {
  const blocks = read(from, to)
  return roomBoxes(playRoom((x, y, z) => blocks.get(`${x} ${y} ${z}`), { from, to }, seeds))
}

/** A box of blocks, both corners included, as room, with a jump's headroom over its top. */
const whole = (from: Block, to: Block): RoomBox => [
  from[0],
  from[2],
  to[0] + 1,
  to[2] + 1,
  from[1],
  to[1] + 1 + HEADROOM,
]

/** A published map's box in the Arcade's world, all of it room. */
function wholeMap(key: string): RoomBox {
  const map = ARCADE_MAPS.find((candidate) => candidate.key === key)
  if (map === undefined) throw new Error(`No Arcade map ${key}`)
  return whole(placed(key, map.from), placed(key, map.to))
}

function arcade(archive: string): Record<string, RoomBox[]> {
  if (createHash('sha512').update(readFileSync(archive)).digest('hex') !== ARCADE_WORLD.sha512)
    throw new Error(`${archive} is not the archive ARCADE_WORLD names`)
  const world = mkdtempSync(join(tmpdir(), 'play-space-'))
  if (spawnSync('tar', ['-xzf', archive, '-C', world], { stdio: 'inherit' }).status !== 0)
    throw new Error(`${archive} would not unpack`)
  const built = blocksSet(buildOf(ARCADE_FILES, new Set(ARCADE_SIGNS.flatMap(buildSign))))
  const read = (from: Block, to: Block) => laidOver(blocksIn(world, from, to), built, from, to)
  const rooms = {
    hub: roomIn(
      read,
      [96, 40, 1336],
      [260, 140, 1470],
      [
        blockOf(HUB_SPAWN),
        blockOf(PASSAGE.house.arrive),
        blockOf(PASSAGE.hall.arrive),
        ...GAMES.map(({ pad: [x, y, z] }): Block => [x, y + 1, z]),
        ...MACHINES.map(({ mouth: [[x, y, z]] }): Block => [x, y, z]),
      ],
    ),
    // A course or an arena, all of it: every block of a published course may be a jump.
    parkour: ['jungle', 'ice', 'debris'].map(wholeMap),
    floor: [
      whole(FLOOR_DISC.from, FLOOR_DISC.to),
      ...roomIn(read, [-8, 55, 44], [8, 70, 58], [blockOf(FLOOR_ARRIVAL)]),
    ],
    pit: [wholeMap('market')],
  }
  rmSync(world, { recursive: true, force: true })
  return rooms
}

/** The void world's platform: stone, 33 blocks square round 8, 8, one block thick, its top at y -61. */
function voidPlatform(): Map<string, string> {
  const blocks = new Map<string, string>()
  for (let x = -8; x <= 24; x++) for (let z = -8; z <= 24; z++) blocks.set(`${x} -61 ${z}`, 'minecraft:stone')
  return blocks
}

function duels(): Record<string, RoomBox[]> {
  const built = blocksSet(buildOf(WAITING_FILES, new Set(DUELS_SIGN_COMMANDS)))
  const read = (from: Block, to: Block) => laidOver(voidPlatform(), built, from, to)
  return { duels: roomIn(read, [-40, -64, -32], [30, -40, 30], DUELS_PLACES.map(blockOf)) }
}

const rooms = {
  arcade: {
    world: ARCADE_WORLD.sha512,
    ...arcade(process.argv[2] ?? 'local/arcade-world/arcade-world.tar.gz'),
  },
  ...duels(),
}
// Gzipped: the hub's grass alone is thousands of columns, each its own height.
writeFileSync(OUT, gzipSync(`${JSON.stringify(rooms)}\n`, { level: 9 }))
for (const [game, boxes] of Object.entries({ ...rooms.arcade, duels: rooms.duels }))
  if (Array.isArray(boxes)) process.stdout.write(`${game}: ${boxes.length} boxes\n`)
