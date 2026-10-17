// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a player alone on a Duels server does while nobody is there to fight: a short parkour off
 * the platform's west edge and a pit off its north edge where everyone fights everyone, and a
 * welcome that points to both and to `/duel join`. Not the arena, the kit or who may play, which
 * are the Duels plugin's (`duels.ts`).
 *
 * All of it is one datapack Cubepals writes into the world the server runs, which Minecraft reads
 * on its own, so no plugin is added for it. As the world loads, it builds the course, the pit and
 * Cubepals' sign beside the void world's platform (`duels.ts` says where that is); a world of
 * another kind, whose arena is a room underground, gets none of them, and its welcome says only how
 * to duel. Every tick it welcomes a player it hasn't, opens or closes the pit, gives whoever drops
 * into the pit the pit's kit and tells them the way out, lets out whoever takes it, shows an open
 * door over the way out and the sign's mark, and sends whoever reaches the end of the parkour back
 * to its start.
 *
 * The pit is a fight, so it is open only while two can have one: while fewer than two players are
 * outside a duel, a lid of glass covers it and the sign over it says why. A player is in a duel
 * while they carry the duel kit's bow, which the pit's kit leaves out. The lid closes only over an
 * empty pit, so it never shuts anyone in.
 *
 * The pit is three blocks deep, so a player leaves it by losing, which drops what they hold, or by
 * the green square in its far corner, which takes back the pit's kit and puts them on the platform;
 * what anyone drops in it is cleared. A player who joins a duel from the pit is put back there
 * afterwards with what they had, as the Duels plugin does for everyone.
 *
 * Measured on Paper 1.21.11 with Duels 4.0.6 (data pack format 94.1): the platform is one block
 * thick, with nothing under it, so a void world is told by the air below its middle.
 */

import { type CarriedFile, RUNNING_LEVEL } from '../domain/revision/carried.ts'
import { MARKERS, type ShownMarker, showMarker } from './brand-pack.ts'
import { DUELS_ARENA } from './duels.ts'
import { buildMarquee, type Frame, type Marquee } from './marquee.ts'

/** The datapack's folder in the running world, and the name Minecraft lists it by. */
export const WAITING_DATAPACK = `${RUNNING_LEVEL}/datapacks/cubepals-duels`

/** The void world's platform is one block thick: below its middle there is nothing. */
const ON_VOID = 'execute if block 8 -62 8 minecraft:air run'

/** The arena's own stone round Cubepals' sign: stone bricks, chiseled at the corners, lit by pale froglights. */
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
  grain: 8,
  frame: ARENA,
  backed: true,
}
const SIGN_PARTS = buildMarquee(BRAND_SIGN, ['cubepals.sign'])
/** Its blocks, built with the course and the pit; its Paper and mark, shown once someone is here, as the way out's marker is. */
export const DUELS_SIGN_COMMANDS = SIGN_PARTS.filter((command) => !command.startsWith('summon '))
const SIGN_DISPLAYS = SIGN_PARTS.filter((command) => command.startsWith('summon '))
const SHOW_SIGN = `execute if entity @a if block 8 -61 25 minecraft:stone_bricks unless entity @e[tag=cubepals.sign] run function cubepals:sign`

/** Where a player is in the pit: inside its walls, from its floor up through its rim. */
const IN_PIT = 'x=-6,y=-64,z=-26,dx=14,dy=3,dz=14'

/** The pit's inside at its rim, where the lid lies while it is closed. */
const LID = 'fill -6 -61 -26 8 -61 -12'

/** The middle of the lid, which says whether the pit is open: air if it is, glass if it isn't. */
const LID_MIDDLE = '1 -61 -19'

/**
 * The sign on the outside of the pit's wall beside the bridge, just under its rim, facing the
 * platform: on the wall, not standing on its top, where players walk round the pit.
 */
const SIGN = '2 -62 -10'

/** Where the sign stood before, on the wall's top: taken away as the pit is built. */
const OLD_SIGN = '2 -60 -11'

/** What the sign says, a line to a row, while the pit is closed and while it is open. */
const CLOSED_SIGN = `data merge block ${SIGN} {front_text:{messages:["the pit is closed:","it opens when","two can fight",""]}}`
const OPEN_SIGN = `data merge block ${SIGN} {front_text:{messages:["the pit:","everyone fights","everyone",""]}}`

/** The way out: a green square in the corner across the pit from the bridge. */
const EXIT = 'fill 7 -64 -26 8 -64 -25 minecraft:lime_concrete'

/**
 * Over the way out, on the pit's wall beside it at eye height, an open door (`brand-pack.ts`). It
 * is shown while someone is on the server, once the world's entities are surely in, and only once.
 */
export const EXIT_MARKER: ShownMarker = {
  marker: MARKERS.wayOut,
  at: [8.97, -62, -25],
  facing: 'west',
  scale: 0.8,
}
const SHOW_EXIT = `execute if entity @a if block 7 -64 -26 minecraft:lime_concrete unless entity @e[type=minecraft:item_display,tag=cubepals.exit] run ${showMarker(EXIT_MARKER, ['cubepals.exit'])}`

/** Where the way out puts a player: on the platform by the bridge, facing away from the pit. */
const OUTSIDE = '1.0 -60 -6.5 0 0'

/** The gold block at the end of the parkour, which also says the course is there. */
export const FINISH = '-32 -55 0'

/** Where the parkour starts: the platform's edge, facing the first jump. */
const START = '-7.5 -60 0.5 90 0'

/** Every place a player is put on a Duels server: the arena's, the parkour's start and the way out of the pit. */
export const DUELS_PLACES: readonly string[] = [...Object.values(DUELS_ARENA), START, OUTSIDE]

/**
 * The course, west of the platform, which ends at x -8: stepping stones two blocks apart, most a
 * block higher than the last, to a pad with the gold block in its middle.
 */
const PARKOUR = [
  'setblock -11 -61 0 minecraft:light_blue_concrete',
  'setblock -14 -60 0 minecraft:light_blue_concrete',
  'setblock -17 -59 1 minecraft:light_blue_concrete',
  'setblock -20 -58 0 minecraft:light_blue_concrete',
  'setblock -23 -58 -2 minecraft:light_blue_concrete',
  'setblock -26 -57 -2 minecraft:light_blue_concrete',
  'setblock -29 -56 0 minecraft:light_blue_concrete',
  'fill -33 -55 -1 -31 -55 1 minecraft:light_blue_concrete',
  `setblock ${FINISH} minecraft:gold_block`,
]

/**
 * The pit, north of the platform, which ends at z -8: walls of stone bricks whose top is level
 * with the platform, a floor three blocks below it at the bottom of the world with the way out in
 * a corner, a bridge from the platform to its rim, and the sign. Its inside is cleared each time,
 * so it is always empty, and closed, since nobody is on a server as it loads.
 */
const PIT = [
  'fill -7 -64 -27 9 -61 -11 minecraft:stone_bricks',
  'fill -6 -63 -26 8 -62 -12 minecraft:air',
  `${LID} minecraft:white_stained_glass`,
  'fill -6 -64 -26 8 -64 -12 minecraft:smooth_stone',
  EXIT,
  'fill 0 -61 -10 1 -61 -9 minecraft:smooth_stone',
  `execute if block ${OLD_SIGN} minecraft:oak_sign run setblock ${OLD_SIGN} minecraft:air`,
  `setblock ${SIGN} minecraft:oak_wall_sign[facing=south]{is_waxed:1b}`,
  CLOSED_SIGN,
]

/** Opening the pit, and closing it. */
const OPEN = [`${LID} minecraft:air replace minecraft:white_stained_glass`, OPEN_SIGN]
const CLOSE = [`${LID} minecraft:white_stained_glass replace minecraft:air`, CLOSED_SIGN]

/** Leaving by the way out: the pit's kit stays behind, and the player is on the platform again. */
const LEAVE = ['clear @s', 'tag @s remove cubepals.pit', `tp @s ${OUTSIDE}`]

/**
 * As the world loads: its chunks kept loaded, the scoreboards of deaths and of who could fight in
 * the pit, and on void, the course and pit.
 */
const LOAD = [
  'forceload add -34 -28 9 1',
  'forceload add 6 25 11 27',
  'scoreboard objectives add cubepals.died deathCount',
  'scoreboard objectives add cubepals.waiting dummy',
  `${ON_VOID} function cubepals:build`,
]

/** The pit's kit: iron and food, the duel kit without the bow. */
const PIT_KIT = [
  `item replace entity @a[tag=!cubepals.pit,${IN_PIT}] armor.head with minecraft:iron_helmet`,
  `item replace entity @a[tag=!cubepals.pit,${IN_PIT}] armor.chest with minecraft:iron_chestplate`,
  `item replace entity @a[tag=!cubepals.pit,${IN_PIT}] armor.legs with minecraft:iron_leggings`,
  `item replace entity @a[tag=!cubepals.pit,${IN_PIT}] armor.feet with minecraft:iron_boots`,
  `give @a[tag=!cubepals.pit,${IN_PIT}] minecraft:iron_sword`,
  `give @a[tag=!cubepals.pit,${IN_PIT}] minecraft:cooked_beef 8`,
]

/** The welcome, once for each player in each world: how to duel, and, where they exist, the rest. */
const WELCOME = [
  'tellraw @a[tag=!cubepals.welcomed] ["Type ",{"text":"/duel join","color":"gold"}," to fight the next player who types it too."]',
  `execute if block ${FINISH} minecraft:gold_block run tellraw @a[tag=!cubepals.welcomed] "While you wait, try the blue parkour, or drop into the pit to fight everyone at once."`,
  'tag @a[tag=!cubepals.welcomed] add cubepals.welcomed',
]

/**
 * Whether two can fight in the pit, counted as players outside a duel, and the pit opened or closed
 * to match. Only where the pit is built: its floor is smooth stone, and its lid glass or air.
 */
const LID_TICK = [
  'scoreboard players set #waiting cubepals.waiting 0',
  'execute as @a[gamemode=!spectator] unless items entity @s container.* minecraft:bow run scoreboard players add #waiting cubepals.waiting 1',
  `execute if score #waiting cubepals.waiting matches 2.. if block ${LID_MIDDLE} minecraft:white_stained_glass run function cubepals:open`,
  `execute if score #waiting cubepals.waiting matches ..1 if block ${LID_MIDDLE} minecraft:air if block -6 -64 -26 minecraft:smooth_stone unless entity @a[${IN_PIT}] run function cubepals:close`,
]

/** Every tick: the welcome, the lid, the pit, its way out and the marker over it, and the end of the parkour. */
const TICK = [
  ...WELCOME,
  ...LID_TICK,
  // A player who lost, in the pit or anywhere, gets the pit's kit again next time they drop in.
  'tag @a[scores={cubepals.died=1..}] remove cubepals.pit',
  'scoreboard players reset @a[scores={cubepals.died=1..}] cubepals.died',
  `clear @a[tag=!cubepals.pit,${IN_PIT}]`,
  ...PIT_KIT,
  `tellraw @a[tag=!cubepals.pit,${IN_PIT}] "To leave the pit, stand on the green square in its far corner. The kit stays here."`,
  `tag @a[tag=!cubepals.pit,${IN_PIT}] add cubepals.pit`,
  `execute as @a[${IN_PIT}] at @s if block ~ ~-1 ~ minecraft:lime_concrete run function cubepals:leave`,
  SHOW_EXIT,
  SHOW_SIGN,
  `kill @e[type=minecraft:item,${IN_PIT}]`,
  `execute as @a at @s if block ~ ~-1 ~ minecraft:gold_block run tellraw @s "You finished the parkour."`,
  `execute as @a at @s if block ~ ~-1 ~ minecraft:gold_block run tp @s ${START}`,
]

const lines = (commands: readonly string[]) => `${commands.join('\n')}\n`

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
    content: '{ "values": ["cubepals:load"] }\n',
  },
  {
    path: `${WAITING_DATAPACK}/data/minecraft/tags/function/tick.json`,
    content: '{ "values": ["cubepals:tick"] }\n',
  },
  { path: `${WAITING_DATAPACK}/data/cubepals/function/load.mcfunction`, content: lines(LOAD) },
  {
    path: `${WAITING_DATAPACK}/data/cubepals/function/build.mcfunction`,
    content: lines([...PARKOUR, ...PIT, ...DUELS_SIGN_COMMANDS]),
  },
  { path: `${WAITING_DATAPACK}/data/cubepals/function/sign.mcfunction`, content: lines(SIGN_DISPLAYS) },
  { path: `${WAITING_DATAPACK}/data/cubepals/function/tick.mcfunction`, content: lines(TICK) },
  { path: `${WAITING_DATAPACK}/data/cubepals/function/open.mcfunction`, content: lines(OPEN) },
  { path: `${WAITING_DATAPACK}/data/cubepals/function/close.mcfunction`, content: lines(CLOSE) },
  { path: `${WAITING_DATAPACK}/data/cubepals/function/leave.mcfunction`, content: lines(LEAVE) },
]
