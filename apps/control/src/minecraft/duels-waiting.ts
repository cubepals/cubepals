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
 * on its own, so no plugin is added for it. As the world loads, it builds the course and the pit
 * beside the void world's platform (`duels.ts` says where that is); a world of another kind, whose
 * arena is a room underground, gets neither, and its welcome says only how to duel. Every tick it
 * welcomes a player it hasn't, gives whoever drops into the pit the pit's kit, and sends whoever
 * reaches the end of the parkour back to its start.
 *
 * The pit is three blocks deep with no way up, so a player leaves it by losing, which drops what
 * they hold; what anyone drops in it is cleared. A player who joins a duel from the pit is put back
 * there afterwards with what they had, as the Duels plugin does for everyone.
 *
 * Measured on Paper 1.21.11 with Duels 4.0.6 (data pack format 94.1): the platform is one block
 * thick, with nothing under it, so a void world is told by the air below its middle.
 */

import { type CarriedFile, RUNNING_LEVEL } from '../domain/revision/carried.ts'

/** The datapack's folder in the running world, and the name Minecraft lists it by. */
const PACK = `${RUNNING_LEVEL}/datapacks/cubepals-duels`

/** The void world's platform is one block thick: below its middle there is nothing. */
const ON_VOID = 'execute if block 8 -62 8 minecraft:air run'

/** Where a player stands in the pit: on its floor, inside its walls. */
const IN_PIT = 'x=-6,y=-64,z=-26,dx=14,dy=2,dz=14'

/** The gold block at the end of the parkour, which also says the course is there. */
const FINISH = '-32 -55 0'

/** Where the parkour starts: the platform's edge, facing the first jump. */
const START = '-7.5 -60 0.5 90 0'

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
 * with the platform, a floor three blocks below it at the bottom of the world, and a bridge from
 * the platform to its rim. Its inside is cleared each time, so it is always empty.
 */
const PIT = [
  'fill -7 -64 -27 9 -61 -11 minecraft:stone_bricks',
  'fill -6 -63 -26 8 -61 -12 minecraft:air',
  'fill -6 -64 -26 8 -64 -12 minecraft:smooth_stone',
  'fill 0 -61 -10 1 -61 -9 minecraft:smooth_stone',
]

/** As the world loads: its chunks kept loaded, the scoreboard of deaths, and on void, the course and pit. */
const LOAD = [
  'forceload add -34 -28 9 1',
  'scoreboard objectives add cubepals.died deathCount',
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

/** Every tick: the welcome, the pit and the end of the parkour. */
const TICK = [
  ...WELCOME,
  // A player who lost, in the pit or anywhere, gets the pit's kit again next time they drop in.
  'tag @a[scores={cubepals.died=1..}] remove cubepals.pit',
  'scoreboard players reset @a[scores={cubepals.died=1..}] cubepals.died',
  `clear @a[tag=!cubepals.pit,${IN_PIT}]`,
  ...PIT_KIT,
  `tag @a[tag=!cubepals.pit,${IN_PIT}] add cubepals.pit`,
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
    path: `${PACK}/pack.mcmeta`,
    content: `${JSON.stringify({ pack: { description: 'Written by Cubepals: parkour and a pit while you wait for a duel.', min_format: 88, max_format: 1000 } }, null, 2)}\n`,
  },
  { path: `${PACK}/data/minecraft/tags/function/load.json`, content: '{ "values": ["cubepals:load"] }\n' },
  { path: `${PACK}/data/minecraft/tags/function/tick.json`, content: '{ "values": ["cubepals:tick"] }\n' },
  { path: `${PACK}/data/cubepals/function/load.mcfunction`, content: lines(LOAD) },
  { path: `${PACK}/data/cubepals/function/build.mcfunction`, content: lines([...PARKOUR, ...PIT]) },
  { path: `${PACK}/data/cubepals/function/tick.mcfunction`, content: lines(TICK) },
]
