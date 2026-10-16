// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's pit, on Overcast's Frozen Market: a free-for-all where everyone fights everyone, as
 * on a Duels server. A player arrives from the hub at one of the market's spawn points, at random,
 * with iron armour, an iron sword and food; losing sends them back to the hub (`hub.ts`). Each kill made in
 * the market counts toward the player's kills, on the hub's board and the sidebar while they are
 * here. Not the boards (`boards.ts`) or the pad that sends players here (`hub.ts`).
 *
 * The spawn points are the map's own, from its `map.xml`, moved to where the market sits in the
 * Arcade's world (`maps.ts`).
 */
import { AS_COUNT, submit, TMP, WORK } from './boards.ts'
import { type Block, box, NS, type Part } from './datapack.ts'
import { placed } from './maps.ts'
import { type BrandSign, creditLabel, hangSign } from './signs.ts'

const PIT = `${NS}.pit`

/** Frozen Market's spawn points, as the map has them, and the way each faces. */
const SPAWNS: ReadonlyArray<{ at: Block; yaw: number }> = [
  { at: [-74, 13, 29], yaw: -101 },
  { at: [-74, 12, -2], yaw: -44 },
  { at: [-77, 13, -13], yaw: -116 },
  { at: [-49, 12, -13], yaw: 10 },
  { at: [-19, 13, -21], yaw: 16 },
  { at: [-24, 13, -18], yaw: 175 },
  { at: [-52, 13, 6], yaw: -90 },
  { at: [-41, 21, -27], yaw: -156 },
  { at: [-58, 17, -31], yaw: -30 },
  { at: [-83, 13, -27], yaw: -25 },
]

/** The market, from below its streets to above its roofs: where the kit is kept and a kill counts. */
const ZONE = box(placed('market', [-90, -4, -37]), placed('market', [-2, 46, 40]))

/** The pit's kit: iron to wear, a sword, and food, since fights here are long. */
const ARMOUR: Readonly<Record<'head' | 'chest' | 'legs' | 'feet', string>> = {
  head: 'iron_helmet',
  chest: 'iron_chestplate',
  legs: 'iron_leggings',
  feet: 'iron_boots',
}

/**
 * The small Cubepals sign over the middle of the market, both ways, so the spawn points on either
 * side see it, on one backing between the two.
 */
export const PIT_SIGNS: readonly BrandSign[] = [
  { art: 'small', at: [-1044, 92, 0], facing: 'north' },
  // One credit line, under this one.
  { art: 'small', at: [-1048, 92, 2], facing: 'south', credit: 'market' },
]
const SIGN_CHUNKS = 'forceload add -1048 0 -1044 2'

export const PIT_PART: Part = {
  functions: {
    // Run as the player, from the hub's pad: the kit, then one of the spawn points.
    'pit/arrive': [
      'clear @s',
      ...Object.entries(ARMOUR).map(
        ([slot, item]) => `item replace entity @s armor.${slot} with minecraft:${item}`,
      ),
      'give @s minecraft:iron_sword',
      'give @s minecraft:cooked_beef 8',
      `tag @s add ${PIT}`,
      `execute store result score #spawn ${TMP} run random value 0..${SPAWNS.length - 1}`,
      ...SPAWNS.map(({ at, yaw }, i) => {
        const [x, y, z] = placed('market', at)
        return `execute if score #spawn ${TMP} matches ${i} run tp @s ${x + 0.5} ${y} ${z + 0.5} ${yaw} 0`
      }),
      `tellraw @s "Everyone here fights everyone, and every kill counts. Losing takes you back to the hub."`,
    ],
    'pit/kill': [
      `execute unless entity @s[tag=${PIT}] run return run scoreboard players reset @s ${PIT}.raw`,
      `scoreboard players operation @s ${PIT}.kills += @s ${PIT}.raw`,
      `scoreboard players reset @s ${PIT}.raw`,
      `execute store result storage ${WORK} new.score int 1 run scoreboard players get @s ${PIT}.kills`,
      AS_COUNT,
      submit('kills'),
    ],
    'pit/leave': [`clear @s`, `tag @s remove ${PIT}`],
  },
  load: [
    // Only while the signs are hung: the market needs nothing loaded when nobody is in it.
    SIGN_CHUNKS,
    `scoreboard objectives add ${PIT}.raw playerKillCount`,
    `scoreboard objectives add ${PIT}.kills dummy {text:"The pit: kills",color:"red",bold:true}`,
    `team add ${PIT}`,
    `team modify ${PIT} color red`,
    `scoreboard objectives setdisplay sidebar.team.red ${PIT}.kills`,
  ],
  labels: PIT_SIGNS.map(creditLabel).filter((credit) => credit !== null),
  build: [...PIT_SIGNS.flatMap(hangSign), SIGN_CHUNKS.replace('add', 'remove')],
  tick: [
    `team join ${PIT} @a[team=!${PIT},${ZONE}]`,
    `execute as @a[scores={${PIT}.raw=1..}] at @s run function ${NS}:pit/kill`,
    `kill @e[type=minecraft:item,${ZONE}]`,
    // Whoever leaves with the kit, for the hub or anywhere, leaves it behind.
    `execute as @a[tag=${PIT}] unless entity @s[${ZONE}] run function ${NS}:pit/leave`,
    // Whoever is here without the kit, say back after a restart, is given it again; not a
    // moderator watching.
    `execute as @a[tag=!${PIT},gamemode=!spectator,${ZONE}] run function ${NS}:pit/arrive`,
  ],
}
