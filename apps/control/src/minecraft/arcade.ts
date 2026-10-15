// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade template's games: timed parkour, a falling floor and a pit, around a hub whose boards
 * keep the top ten of each. Fun alone against your own best, and with two or three friends against
 * each other.
 *
 * The world is made of published maps (`arcade/maps.ts`), built once into one world by
 * `scripts/arcade-world.ts`, which reaches a server as an archive (`ARCADE_WORLD`). The games are
 * one datapack Cubepals writes into that world, which Minecraft reads on its own, so no plugin is
 * added for any game. Scores and boards live in the world's own scoreboard and storage, so they
 * hold through restarts and sleep. On any other world, such as one made with "Make your own
 * world", it does nothing.
 *
 * Parts (`arcade/`):
 * - `datapack.ts`: the shape of a part, the hub's place, a place in a selector, and labels.
 * - `maps.ts`: the published maps, their builders, licences, changes and places in the world.
 * - `credits.ts`: who made each map, its licence and source as links, in the game and the archive.
 * - `signs.ts`: the Cubepals signs, the lockup as map art in frames, over the hub and each game.
 * - `boards.ts`: the leaderboards: keeping each top ten in storage and drawing it in the hub.
 * - `hub.ts`: the hub, its pads, the welcome, the ways back, and the world's rules.
 * - `parkour.ts`: the timed parkour over three courses, its checkpoints and best times.
 * - `floor.ts`: the falling floor, its rounds, longest times and wins.
 * - `pit.ts`: the pit, its spawn points, kit and kills.
 */
import { type CarriedFile, RUNNING_LEVEL } from '../domain/revision/carried.ts'
import { BOARDS_PART, TMP } from './arcade/boards.ts'
import { NS, type Part } from './arcade/datapack.ts'
import { FLOOR_PART } from './arcade/floor.ts'
import { HUB_PART, PADS } from './arcade/hub.ts'
import { PARKOUR_PART } from './arcade/parkour.ts'
import { PIT_PART } from './arcade/pit.ts'

/** The datapack's folder in the running world, and the name Minecraft lists it by. */
const PACK = `${RUNNING_LEVEL}/datapacks/cubepals-arcade`

/**
 * In the order each tick runs them: the boards' scratch objective is made before anyone uses it,
 * and a game catches its own falls before the hub catches anyone else's.
 */
const PARTS: readonly Part[] = [BOARDS_PART, PARKOUR_PART, FLOOR_PART, PIT_PART, HUB_PART]

/**
 * How long after the world loads its chunks are built in, in ticks. Forcing a chunk to load
 * doesn't load it, or the entities in it, at once: building any sooner could miss a block, or
 * leave the last build's labels standing beside the new ones.
 */
const BUILD_AFTER = 40

const LOAD = [...PARTS.flatMap((part) => part.load), `scoreboard players set #build ${TMP} ${BUILD_AFTER}`]

/**
 * The hub's middle pad, which only the Arcade's world has: on any other, such as one made with
 * "Make your own world", the datapack builds nothing, sets no rules and runs no game.
 */
const [px, py, pz] = PADS[1]?.middle ?? [0, 0, 0]
const ARCADE_WORLD_HERE = `block ${px} ${py} ${pz} minecraft:black_concrete`

const BUILD = [
  `execute unless ${ARCADE_WORLD_HERE} run return run scoreboard players set #build ${TMP} -2`,
  `function ${NS}:rules`,
  `kill @e[type=!minecraft:player,tag=${NS}.display]`,
  ...PARTS.flatMap((part) => part.build),
  `scoreboard players set #build ${TMP} -1`,
]

const TICK = [
  `execute if score #build ${TMP} matches 1.. run scoreboard players remove #build ${TMP} 1`,
  `execute if score #build ${TMP} matches 0 run function ${NS}:build`,
  `execute if score #build ${TMP} matches -1 run function ${NS}:play`,
]

const lines = (commands: readonly string[]) => `${commands.join('\n')}\n`

const FUNCTIONS: Record<string, readonly string[]> = {
  load: LOAD,
  build: BUILD,
  tick: TICK,
  play: PARTS.flatMap((part) => part.tick),
  ...Object.assign({}, ...PARTS.map((part) => part.functions)),
}

/**
 * The datapack's files. It is for 1.21.9 and later (data pack format 88 and up), which name a
 * pack's formats as a range, and write text in commands the way it is written here.
 */
export const ARCADE_FILES: readonly CarriedFile[] = [
  {
    path: `${PACK}/pack.mcmeta`,
    content: `${JSON.stringify({ pack: { description: 'Written by Cubepals: the Arcade’s games and boards.', min_format: 88, max_format: 1000 } }, null, 2)}\n`,
  },
  { path: `${PACK}/data/minecraft/tags/function/load.json`, content: `{ "values": ["${NS}:load"] }\n` },
  { path: `${PACK}/data/minecraft/tags/function/tick.json`, content: `{ "values": ["${NS}:tick"] }\n` },
  ...PARTS.flatMap((part) =>
    Object.entries(part.data ?? {}).map(([name, json]) => ({
      path: `${PACK}/data/${NS}/${name}`,
      content: `${JSON.stringify(json, null, 2)}\n`,
    })),
  ),
  ...Object.entries(FUNCTIONS).map(([name, commands]) => ({
    path: `${PACK}/data/${NS}/function/${name}.mcfunction`,
    content: lines(commands),
  })),
]
