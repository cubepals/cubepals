// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's pit, north of the hub: a walled pit where everyone fights everyone, as on a Duels
 * server. Dropping in gives iron armour, an iron sword and food; a player leaves by losing, and
 * comes back at the hub. Each kill made in the pit counts toward the player's kills, on the hub's
 * board and the sidebar while they are here. Not the boards (`boards.ts`) or the way here from the
 * hub (`hub.ts`).
 */
import { AS_COUNT, submit, WORK } from './boards.ts'
import { type Block, box, fill, label, NS, type Part, TO_HUB } from './datapack.ts'

const PIT = `${NS}.pit`

/** Where a player arrives from the hub: the platform at the pit's south rim, facing it. */
export const PIT_ARRIVAL = '-1.5 101 -21.5 180 0'

const LANDING_FROM: Block = [-3, 100, -24]
const LANDING_TO: Block = [3, 100, -18]
const BACK_FROM: Block = [1, 100, -20]
const BACK_TO: Block = [3, 100, -18]

/** Inside the walls, on the pit's floor: where the kit is given and a kill counts. */
const IN_PIT = box([-7, 97, -40], [7, 99, -26])
const ZONE = box([-12, 85, -45], [12, 140, -17])

/** The pit's kit: iron to wear, a sword, and food, since fights here are long. */
const ARMOUR = ['head', 'chest', 'legs', 'feet'] as const
const ARMOUR_ITEMS: Record<(typeof ARMOUR)[number], string> = {
  head: 'iron_helmet',
  chest: 'iron_chestplate',
  legs: 'iron_leggings',
  feet: 'iron_boots',
}
const ARRIVING = `@a[tag=!${PIT},${IN_PIT}]`

export const PIT_PART: Part = {
  functions: {
    'pit/kill': [
      `execute unless entity @s[tag=${PIT}] run return run scoreboard players reset @s ${PIT}.raw`,
      `scoreboard players operation @s ${PIT}.kills += @s ${PIT}.raw`,
      `scoreboard players reset @s ${PIT}.raw`,
      `execute store result storage ${WORK} new.score int 1 run scoreboard players get @s ${PIT}.kills`,
      AS_COUNT,
      submit('kills'),
    ],
  },
  load: [
    'forceload add -12 -45 12 -17',
    `scoreboard objectives add ${PIT}.raw playerKillCount`,
    `scoreboard objectives add ${PIT}.died deathCount`,
    `scoreboard objectives add ${PIT}.kills dummy {text:"The pit: kills",color:"red",bold:true}`,
    `team add ${PIT}`,
    `team modify ${PIT} color red`,
    `scoreboard objectives setdisplay sidebar.team.red ${PIT}.kills`,
  ],
  build: [
    fill([-8, 96, -41], [8, 100, -25], 'stone_bricks'),
    fill([-7, 97, -40], [7, 100, -26], 'air'),
    fill([-7, 96, -40], [7, 96, -26], 'smooth_stone'),
    fill(LANDING_FROM, LANDING_TO, 'smooth_stone'),
    fill(BACK_FROM, BACK_TO, 'quartz_block'),
    label(
      '-0.5 102.5 -23',
      `${NS}.label`,
      '["",{text:"The pit\\n",color:"red",bold:true},"Drop in for armour and a sword. Everyone fights everyone, and every kill counts."]',
    ),
    label('2 102 -19', `${NS}.label`, '"Back to the hub"'),
    'forceload remove -12 -45 12 -17',
  ],
  tick: [
    `team join ${PIT} @a[team=!${PIT},${ZONE}]`,
    `execute as @a[${box(BACK_FROM, [BACK_TO[0], 102, BACK_TO[2]])}] run function ${TO_HUB}`,
    // Losing, here or anywhere, means dropping in again gives the kit again.
    `tag @a[scores={${PIT}.died=1..}] remove ${PIT}`,
    `scoreboard players reset @a[scores={${PIT}.died=1..}] ${PIT}.died`,
    `clear ${ARRIVING}`,
    ...ARMOUR.map(
      (slot) => `item replace entity ${ARRIVING} armor.${slot} with minecraft:${ARMOUR_ITEMS[slot]}`,
    ),
    `give ${ARRIVING} minecraft:iron_sword`,
    `give ${ARRIVING} minecraft:cooked_beef 8`,
    `tag ${ARRIVING} add ${PIT}`,
    `kill @e[type=minecraft:item,${IN_PIT}]`,
    `execute as @a[scores={${PIT}.raw=1..}] at @s run function ${NS}:pit/kill`,
    // Whoever leaves with the kit, for the hub, leaves it behind.
    `execute as @a[tag=${PIT}] unless entity @s[${ZONE}] run clear @s`,
    `execute as @a[tag=${PIT}] unless entity @s[${ZONE}] run tag @s remove ${PIT}`,
  ],
}
