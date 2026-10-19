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
 * `scripts/arcade-clearance.ts` takes it; without one, the Arcade's room is kept as the file has it
 * and Duels' alone is worked out again. The Arcade is read as its datapack leaves it, the maps'
 * blocks with the datapack's own laid over them, its signs left out; Duels as its waiting datapack
 * builds beside the void world's platform, its maps' structures placed and its signs left out. A
 * published course is room all through, every block of it a place a jump may land: the Arcade's
 * three courses, the market and the falling floor's floors, and Duels' two courses. Everywhere else, from every place a game puts a player
 * (spawns, arrivals, pads, machines), it walks where a player can go (`lib/play-reach.ts`). It
 * writes that room as boxes. It writes no block of the maps, which stay
 * out of this repository. Run it again when a game's places, the build or the world change.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import nbt from 'prismarine-nbt'
import { STRUCTURES_DIR } from '../apps/control/src/app/setups/duels-structures.ts'
import { HUB_SPAWN } from '../apps/control/src/minecraft/arcade/datapack.ts'
import { FLOOR_ARRIVAL, FLOOR_DISC } from '../apps/control/src/minecraft/arcade/floor.ts'
import { PASSAGE } from '../apps/control/src/minecraft/arcade/hub.ts'
import { MACHINES } from '../apps/control/src/minecraft/arcade/machines.ts'
import { ARCADE_MAPS, ARCADE_WORLD, placed } from '../apps/control/src/minecraft/arcade/maps.ts'
import { buildSign } from '../apps/control/src/minecraft/arcade/signs.ts'
import { GAMES } from '../apps/control/src/minecraft/arcade/ways-in.ts'
import { ARCADE_FILES, ARCADE_SIGNS } from '../apps/control/src/minecraft/arcade.ts'
import { DUELS_ARENA } from '../apps/control/src/minecraft/duels.ts'
import { DUELS_MAPS, placed as placedBeside } from '../apps/control/src/minecraft/duels-waiting/maps.ts'
import { PARKOUR_LOBBY } from '../apps/control/src/minecraft/duels-waiting/parkour.ts'
import { OUTSIDE, PIT_SPAWNS } from '../apps/control/src/minecraft/duels-waiting/pit.ts'
import { DUELS_SIGN_COMMANDS, WAITING_FILES } from '../apps/control/src/minecraft/duels-waiting.ts'
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

/** Duels' maps' blocks, where the waiting datapack places them, read from their structures. */
function placedMaps(): Map<string, string> {
  const blocks = new Map<string, string>()
  for (const map of DUELS_MAPS) {
    const root = nbt.simplify(
      nbt.parseUncompressed(gunzipSync(readFileSync(`${STRUCTURES_DIR}${map.key}.nbt`))),
    )
    const palette = root.palette as { Name: string }[]
    const [ox, oy, oz] = placedBeside(map.key, map.from)
    for (const { state, pos } of root.blocks as { state: number; pos: [number, number, number] }[])
      blocks.set(`${pos[0] + ox} ${pos[1] + oy} ${pos[2] + oz}`, palette[state]?.Name ?? 'minecraft:stone')
  }
  return blocks
}

/** A Duels map's box beside the platform. */
function besideMap(key: string): [Block, Block] {
  const map = DUELS_MAPS.find((candidate) => candidate.key === key)
  if (map === undefined) throw new Error(`No Duels map ${key}`)
  return [placedBeside(key, map.from), placedBeside(key, map.to)]
}

function duels(): Record<string, RoomBox[]> {
  // What the build sets once the maps are in: it clears the old lobby before placing them.
  const build = buildOf(WAITING_FILES, new Set(DUELS_SIGN_COMMANDS))
  const built = blocksSet(
    build.slice(build.findLastIndex((command) => command.startsWith('place template '))),
  )
  const world = new Map([...voidPlatform(), ...placedMaps()])
  const read = (from: Block, to: Block) => laidOver(new Map(world), built, from, to)
  const [pitFrom, pitTo] = besideMap('cramped')
  const onPlatform = [...Object.values(DUELS_ARENA), PARKOUR_LOBBY, OUTSIDE].map(blockOf)
  return {
    duels: [
      // The platform and its pads, from every place a player is put on it.
      ...roomIn(read, [-40, -64, -32], [30, -40, 30], onPlatform),
      // Both courses, all of them.
      ...['ice', 'debris'].map((key) => whole(...besideMap(key))),
      // The pit, where its fighters can go from its spawn points.
      ...roomIn(read, pitFrom, pitTo, PIT_SPAWNS.map(blockOf)),
    ],
  }
}

/** The Arcade's room as the file already has it, for a run without its world. */
function keptArcade(): Record<string, unknown> {
  const kept = JSON.parse(gunzipSync(readFileSync(OUT)).toString()) as { arcade: Record<string, unknown> }
  return kept.arcade
}

const archive = process.argv[2] ?? 'local/arcade-world/arcade-world.tar.gz'
const rooms = {
  arcade: existsSync(archive) ? { world: ARCADE_WORLD.sha512, ...arcade(archive) } : keptArcade(),
  ...duels(),
}
// Gzipped: the hub's grass alone is thousands of columns, each its own height.
writeFileSync(OUT, gzipSync(`${JSON.stringify(rooms)}\n`, { level: 9 }))
for (const [game, boxes] of Object.entries({ ...rooms.arcade, duels: rooms.duels }))
  if (Array.isArray(boxes)) process.stdout.write(`${game}: ${boxes.length} boxes\n`)
