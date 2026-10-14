// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade template's games: timed parkour, a falling floor and a pit, around a hub in the sky
 * whose boards keep the top ten of each. Fun alone against your own best, and with two or three
 * friends against each other.
 *
 * All of it is one datapack Cubepals writes into the world the server runs, which Minecraft reads
 * on its own, so no plugin is added for any game, and it runs on whichever release the server
 * does. Scores and boards live in the world's own scoreboard and storage, so they hold through
 * restarts and sleep, and start again on a fresh world, as the world's own things do.
 *
 * Everything is built at fixed places from y 100 up, with the void below, and built again each time
 * the world loads: a block knocked out is back by the next start. On a world of another kind, made
 * with "Make your own world", the room around each place is cleared first, so it stands the same.
 *
 * Parts (`arcade/`):
 * - `datapack.ts`: the shape of a part, the hub's place, and how a place is named in a selector.
 * - `boards.ts`: the leaderboards: keeping each top ten in storage and drawing it in the hub.
 * - `hub.ts`: the hub, its pads, the welcome, the ways back to it, and the world's rules.
 * - `parkour.ts`: the timed parkour, its checkpoints and best times.
 * - `floor.ts`: the falling floor, its rounds, longest times and wins.
 * - `pit.ts`: the pit, its kit and kills.
 */
import { type CarriedFile, RUNNING_LEVEL } from '../domain/revision/carried.ts'
import { BOARDS_PART, TMP } from './arcade/boards.ts'
import { NS, type Part } from './arcade/datapack.ts'
import { FLOOR_PART } from './arcade/floor.ts'
import { HUB_PART } from './arcade/hub.ts'
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

const LOAD = [
  ...PARTS.flatMap((part) => part.load),
  `function ${NS}:rules`,
  `scoreboard players set #build ${TMP} ${BUILD_AFTER}`,
]

const BUILD = [
  `kill @e[type=minecraft:text_display,tag=${NS}.display]`,
  ...PARTS.flatMap((part) => part.build),
  `scoreboard players set #build ${TMP} -1`,
]

const TICK = [
  `execute if score #build ${TMP} matches 1.. run scoreboard players remove #build ${TMP} 1`,
  `execute if score #build ${TMP} matches 0 run function ${NS}:build`,
  ...PARTS.flatMap((part) => part.tick),
]

const lines = (commands: readonly string[]) => `${commands.join('\n')}\n`

const FUNCTIONS: Record<string, readonly string[]> = {
  load: LOAD,
  build: BUILD,
  tick: TICK,
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
