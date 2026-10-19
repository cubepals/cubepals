// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a player on a Duels server does while nobody is there to fight: a timed parkour over two
 * published courses off the platform's west edge, a pit in a published arena off its north edge
 * where everyone fights everyone, and a welcome that points to both and to `/duel join`. Outside
 * the pit and duels the lobby is peaceful: nobody there hurts or is hurt by anyone. Not the arena,
 * the kit or who may play, which are the Duels plugin's (`duels.ts`).
 *
 * All of it is one datapack Cubepals writes into the world the server runs, which Minecraft reads
 * on its own, so no plugin is added for it; the maps' structures are carried beside its files
 * (`app/setups/duels-structures.ts`). A moment after the world loads, it places the maps as
 * structures beside the void world's platform (`duels.ts` says where that is), with their pads and
 * Cubepals' signs; a world of another kind, whose arena is a room underground, gets none of them,
 * and its welcome says only how to duel. Scores and the board live in the world's own scoreboard
 * and storage, so they hold through restarts and sleep.
 *
 * Parts (`duels-waiting/`):
 * - `maps.ts`: the published maps, their builders, licences, changes, places and credits.
 * - `parkour.ts`: the timed parkour over two courses, its checkpoints, best times and board.
 * - `pit.ts`: the pit, its pad and lid, spawn points, kit and way out.
 *
 * Measured on Paper 1.21.11 with Duels 4.0.6 (data pack format 94.1): the platform is one block
 * thick, with nothing under it, so a void world is told by the air below its middle.
 */

import type { CarriedFile } from '../domain/revision/carried.ts'
import type { Part } from './arcade/datapack.ts'
import { DUELS_ARENA } from './duels.ts'
import {
  CREDIT_LINES,
  CREDITS_TEXT,
  DUELS_MAPS,
  NS,
  placeMap,
  WAITING_DATAPACK,
} from './duels-waiting/maps.ts'
import {
  BOARD_LABEL,
  PARKOUR_LOBBY,
  PARKOUR_PAD,
  PARKOUR_PART,
  PARKOUR_START,
} from './duels-waiting/parkour.ts'
import { IN_PIT, OUTSIDE, PIT_PART, PIT_SPAWNS } from './duels-waiting/pit.ts'
import { artFiles, MAPS_1_21_11 } from './map-art.ts'
import { buildMarquee, clearOldBase, type Frame, footOf, type Marquee } from './marquee.ts'

// What outsiders read here, at the path they always have.
export { WAITING_DATAPACK } from './duels-waiting/maps.ts'
export { EXIT_MARKER } from './duels-waiting/pit.ts'

/** The void world's platform is one block thick: below its middle there is nothing. */
const ON_VOID = 'execute if block 8 -62 8 minecraft:air run'

/** The arena's own stone round Cubepals' signs: stone bricks, chiseled at the corners, lit by pale froglights. */
const ARENA: Frame = {
  casing: 'stone_bricks',
  corner: 'chiseled_stone_bricks',
  bulb: 'pearlescent_froglight',
  lamp: 'stone_bricks',
}

/**
 * Cubepals' sign, the mark in Ink on Paper in a frame of the arena's stone (`marquee.ts`): against
 * the platform's south edge, off it, its base level with the platform's top, facing back across it
 * to where a player arrives.
 */
export const BRAND_SIGN: Marquee = {
  at: [10, -57, 26],
  facing: 'north',
  side: 4,
  art: { side: 4, firstId: 9200 },
  frame: ARENA,
  backed: true,
}

/**
 * A smaller sign at the start of each game, beside its pad, facing the platform: the parkour's
 * south of its pad, the pit's east of its. Both show the same maps.
 */
const START_ART = { side: 2, firstId: 9216 }
export const START_SIGNS: readonly Marquee[] = [
  { at: [-12, -59, 5], facing: 'east', side: 2, art: START_ART, frame: ARENA, backed: true },
  { at: [12, -59, -12], facing: 'south', side: 2, art: START_ART, frame: ARENA, backed: true },
]

/**
 * Every display the signs have had carries `cubepals.sign`; their maps carry `cubepals.sign.maps`
 * too. A server that showed the sign as blocks of colour before keeps those displays in its world:
 * they are taken down as the maps go up, and any that load after, as they load.
 */
const SIGN_MAPS = 'cubepals.sign.maps'
const SIGN_PARTS = [BRAND_SIGN, ...START_SIGNS].flatMap((sign) =>
  buildMarquee(sign, ['cubepals.sign', SIGN_MAPS]),
)
/** Their blocks, built with the maps; their Paper and mark, shown once someone is here, as the way out's marker is. */
export const DUELS_SIGN_COMMANDS = [
  // The sign as first built stood a block proud of its base too, off the platform's edge, over the void.
  clearOldBase(BRAND_SIGN),
  ...SIGN_PARTS.filter((command) => !command.startsWith('summon ')),
]
const SIGN_DISPLAYS = [
  'kill @e[type=!minecraft:player,tag=cubepals.sign]',
  ...SIGN_PARTS.filter((command) => command.startsWith('summon ')),
]
/**
 * The maps are shown while someone is here, once the signs are built and the maps of the last of
 * them, the pit's, are not up: a server whose world shows the first sign alone shows all three.
 */
const LAST_SIGN = START_SIGNS.at(-1) ?? BRAND_SIGN
const SIGN_FOOT = footOf(LAST_SIGN)
const [lx, ly, lz] = LAST_SIGN.at
const SHOW_SIGN = `execute if entity @a if block ${SIGN_FOOT.at.join(' ')} minecraft:${SIGN_FOOT.block} unless entity @e[tag=${SIGN_MAPS},x=${lx},y=${ly},z=${lz + 1},distance=..1] run function cubepals:sign`
const OLD_SIGN_DISPLAYS = `kill @e[type=!minecraft:player,tag=cubepals.sign,tag=!${SIGN_MAPS}]`

/** Every label the datapack makes: the parkour's board. */
export const DUELS_LABELS = [BOARD_LABEL]

/** Every place a player is put on a Duels server: the arena's, the parkour's start and the ways back. */
export const DUELS_PLACES: readonly string[] = [
  ...Object.values(DUELS_ARENA),
  PARKOUR_START,
  PARKOUR_LOBBY,
  OUTSIDE,
]

/**
 * What the lobby first had, built block by block: a course of stepping stones off the platform's
 * west edge and a box of a pit off its north edge, with its bridge, sign and way out. Taken down
 * before the maps go in, where they don't cover it.
 */
const OLD_BUILDS = [
  'fill -33 -61 -2 -11 -55 2 minecraft:air',
  'fill -7 -64 -27 9 -60 -9 minecraft:air',
  'kill @e[type=minecraft:item_display,tag=cubepals.exit]',
]

/** The chunks the lobby is in, kept loaded: the courses, the pit, the pads and the signs. */
const CHUNKS = 'forceload add -53 -58 30 27'

/** How long after the world loads its chunks are built in, in ticks, so no block is missed. */
const BUILD_AFTER = 40

/** The lobby's credits, by `/trigger credits`. */
const CREDITS = 'credits'

/**
 * Peaceful outside the pit and duels: a player in neither is in adventure mode, and deals and takes
 * no harm, as weakness and resistance at their utmost, hidden, do. The void still takes whoever
 * falls into it. A player who dies loses both, and gets them again at once if still outside.
 */
const CALM = `${NS}.calm`
const OUTSIDE_FIGHTS = `@a[tag=!${CALM},tag=!${NS}.pit,gamemode=!spectator,gamemode=!creative]`
const CALM_PART: Part = {
  functions: {
    calm: [
      `tag @s add ${CALM}`,
      'gamemode adventure @s[gamemode=survival]',
      'effect give @s minecraft:weakness infinite 255 true',
      'effect give @s minecraft:resistance infinite 4 true',
    ],
    uncalm: [
      `tag @s remove ${CALM}`,
      'effect clear @s minecraft:weakness',
      'effect clear @s minecraft:resistance',
    ],
  },
  load: [],
  build: [],
  tick: [
    `execute as @a[tag=${CALM}] if items entity @s container.* minecraft:bow run function ${NS}:uncalm`,
    `execute as @a[tag=${CALM},${IN_PIT}] run function ${NS}:uncalm`,
    `execute as ${OUTSIDE_FIGHTS} unless items entity @s container.* minecraft:bow unless entity @s[${IN_PIT}] run function ${NS}:calm`,
  ],
}

/** The welcome, once for each player in each world: how to duel, and, where they exist, the rest. */
const WELCOME = [
  'tellraw @a[tag=!cubepals.welcomed] ["Type ",{"text":"/duel join","color":"gold"}," to fight the next player who types it too."]',
  `execute if block ${PARKOUR_PAD.from.join(' ')} minecraft:yellow_concrete run tellraw @a[tag=!cubepals.welcomed] "While you wait, step on a yellow pad: west for the parkour, north for the pit, where everyone fights everyone."`,
  `execute if block ${PARKOUR_PAD.from.join(' ')} minecraft:yellow_concrete run tellraw @a[tag=!cubepals.welcomed] ["",{"text":"Type ","color":"gray"},{"text":"/trigger credits","color":"gold"},{"text":" for who built the maps.","color":"gray"}]`,
  'tag @a[tag=!cubepals.welcomed] add cubepals.welcomed',
]

/** The parts, in the order each tick runs them. */
const PARTS: readonly Part[] = [PARKOUR_PART, PIT_PART, CALM_PART]

/**
 * As the world loads: its chunks kept loaded, the scoreboards of deaths and credits and each
 * part's, and, on void, the build a moment later.
 */
const LOAD = [
  CHUNKS,
  'scoreboard objectives add cubepals.died deathCount',
  `scoreboard objectives add ${CREDITS} trigger`,
  ...PARTS.flatMap((part) => part.load),
  `${ON_VOID} scoreboard players set #build ${NS}.waiting ${BUILD_AFTER}`,
]

/** The build, once the chunks are in: the old lobby down, the maps placed, then each part's own. */
const BUILD = [
  ...OLD_BUILDS,
  ...DUELS_MAPS.map(({ key }) => placeMap(key)),
  ...PARTS.flatMap((part) => part.build),
  ...DUELS_SIGN_COMMANDS,
]

/** Every tick: the build when it is due, the welcome, credits, each part, and the signs. */
const TICK = [
  `execute if score #build ${NS}.waiting matches 1.. run scoreboard players remove #build ${NS}.waiting 1`,
  `execute if score #build ${NS}.waiting matches 0 run function ${NS}:build`,
  `execute if score #build ${NS}.waiting matches 0 run scoreboard players set #build ${NS}.waiting -1`,
  ...WELCOME,
  // A player who died gets the pit's kit again next time they arrive, and is calmed again outside.
  `tag @a[scores={cubepals.died=1..}] remove ${NS}.pit`,
  `tag @a[scores={cubepals.died=1..}] remove ${CALM}`,
  'scoreboard players reset @a[scores={cubepals.died=1..}] cubepals.died',
  `scoreboard players enable @a ${CREDITS}`,
  `execute as @a[scores={${CREDITS}=1..}] run function ${NS}:credits`,
  ...PARTS.flatMap((part) => part.tick),
  SHOW_SIGN,
  OLD_SIGN_DISPLAYS,
]

const lines = (commands: readonly string[]) => `${commands.join('\n')}\n`

const FUNCTIONS: Record<string, readonly string[]> = {
  load: LOAD,
  build: BUILD,
  sign: SIGN_DISPLAYS,
  tick: TICK,
  credits: [`scoreboard players reset @s ${CREDITS}`, ...CREDIT_LINES.map((line) => `tellraw @s ${line}`)],
  ...Object.assign({}, ...PARTS.map((part) => part.functions)),
}

/**
 * The datapack's files. It is for 1.21.9 and later (data pack format 88 and up), which name a
 * pack's formats as a range; the Duels plugin runs on 1.21.11, and nothing it uses has changed since.
 */
export const WAITING_FILES: readonly CarriedFile[] = [
  {
    path: `${WAITING_DATAPACK}/pack.mcmeta`,
    content: `${JSON.stringify({ pack: { description: 'Written by Cubepals: parkour and a pit while you wait for a duel.', min_format: 88, max_format: 1000 } }, null, 2)}\n`,
  },
  {
    path: `${WAITING_DATAPACK}/data/minecraft/tags/function/load.json`,
    content: `{ "values": ["${NS}:load"] }\n`,
  },
  {
    path: `${WAITING_DATAPACK}/data/minecraft/tags/function/tick.json`,
    content: `{ "values": ["${NS}:tick"] }\n`,
  },
  ...PARTS.flatMap((part) =>
    Object.entries(part.data ?? {}).map(([name, json]) => ({
      path: `${WAITING_DATAPACK}/data/${NS}/${name}`,
      content: `${JSON.stringify(json, null, 2)}\n`,
    })),
  ),
  ...Object.entries(FUNCTIONS).map(([name, commands]) => ({
    path: `${WAITING_DATAPACK}/data/${NS}/function/${name}.mcfunction`,
    content: lines(commands),
  })),
  // Who built the maps, beside them; the maps' structures are carried with these (`DUELS_STRUCTURES`).
  { path: `${WAITING_DATAPACK}/CREDITS.txt`, content: `${CREDITS_TEXT}\n` },
  // The maps the signs show, in the world's data beside the datapack, as 1.21.11 keeps them.
  ...artFiles(BRAND_SIGN.art, MAPS_1_21_11),
  ...artFiles(START_ART, MAPS_1_21_11),
]
