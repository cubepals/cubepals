// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's falling floor, east of the hub: two floors over the void, whose blocks turn red
 * under a player's feet and drop a moment later. Players wait for a round in a lobby beside it; a
 * round starts ten seconds after someone is waiting, with everyone waiting by then. With two or
 * more, the last one standing wins, and the last two falling together is a draw; alone, it is how
 * long you last. Both are kept: the longest anyone lasted, and wins. Not the boards (`boards.ts`)
 * or the way here from the hub (`hub.ts`).
 *
 * A round is `#state` in its objective: 0 nobody waiting, 1 counting down, 2 under way.
 */
import { AS_COUNT, onSidebar, SECONDS, shown, submit, TMP, WORK } from './boards.ts'
import { type Block, box, FALLEN, fill, label, NS, type Part, TO_HUB } from './datapack.ts'

const FF = `${NS}.ff`

/** Where a player arrives from the hub, and goes back to between rounds: the lobby, facing the floor. */
export const FLOOR_ARRIVAL = '32.5 101 1.5 -90 0'

const LOBBY_FROM: Block = [28, 100, -3]
const LOBBY_TO: Block = [36, 100, 3]
const BACK_FROM: Block = [28, 100, -3]
const BACK_TO: Block = [30, 100, -1]

/** The two floors, six blocks apart, and the blocks they are made of. */
const FLOORS: ReadonlyArray<readonly [Block, Block, string]> = [
  [[40, 100, -10], [60, 100, 10], 'white_concrete'],
  [[40, 94, -10], [60, 94, 10], 'yellow_concrete'],
]

/** How long a block stays red under a player before it drops, in ticks. */
const DROP_AFTER = 8

/** How long the countdown to a round is, in ticks: ten seconds. */
const COUNTDOWN = 200

const LOBBY = box([LOBBY_FROM[0], 101, LOBBY_FROM[2]], [LOBBY_TO[0], 103, LOBBY_TO[2]])
/** Above and between the floors: nobody is here but who is playing the round. */
const ARENA = box([40, 95, -10], [60, 115, 10])
/** Where a player in a round may be, falling included; one anywhere else has left the round. */
const ROUND = box([38, -128, -12], [62, 140, 12])
const ZONE = box([26, 85, -14], [64, 140, 14])
const ALIVE = `tag=${FF}.alive`

/** The four corners under a player's feet, so a block they only half stand on drops too. */
const CORNERS = ['0.3 ~-0.5 ~0.3', '-0.3 ~-0.5 ~0.3', '0.3 ~-0.5 ~-0.3', '-0.3 ~-0.5 ~-0.3']

export const FLOOR_PART: Part = {
  functions: {
    'floor/rebuild': FLOORS.map(([from, to, block]) => fill(from, to, block)),
    'floor/countdown': [
      `execute if score #waiting ${FF} matches 0 run return run scoreboard players set #state ${FF} 0`,
      `scoreboard players remove #clock ${FF} 1`,
      `scoreboard players operation #sec ${FF} = #clock ${FF}`,
      `scoreboard players operation #sec ${FF} /= #20 ${TMP}`,
      `scoreboard players add #sec ${FF} 1`,
      `title @a[${LOBBY}] actionbar ["Next round in ",{score:{name:"#sec",objective:"${FF}"}}]`,
      `execute if score #clock ${FF} matches ..0 run function ${NS}:floor/start`,
    ],
    'floor/start': [
      `function ${NS}:floor/rebuild`,
      `kill @e[type=minecraft:marker,tag=${FF}.drop]`,
      `tag @a[${LOBBY}] add ${FF}.alive`,
      `scoreboard players set @a[${ALIVE}] ${FF}.time 0`,
      `execute store result score #started ${FF} if entity @a[${ALIVE}]`,
      `spreadplayers 50.5 0.5 2 8 under 102 false @a[${ALIVE}]`,
      `tp @a[${ALIVE},${LOBBY}] 50.5 101 0.5`,
      `scoreboard players set #state ${FF} 2`,
      `tellraw @a[${ALIVE}] "Go! The floor drops away wherever you step, so keep moving."`,
    ],
    'floor/round': [
      `scoreboard players add @a[${ALIVE}] ${FF}.time 1`,
      `execute as @a[${ALIVE}] at @s run function ${NS}:floor/step`,
      `scoreboard players add @e[type=minecraft:marker,tag=${FF}.drop] ${FF}.age 1`,
      `execute as @e[type=minecraft:marker,tag=${FF}.drop,scores={${FF}.age=${DROP_AFTER}..}] at @s run setblock ~ ~ ~ minecraft:air`,
      `kill @e[type=minecraft:marker,tag=${FF}.drop,scores={${FF}.age=${DROP_AFTER}..}]`,
      `execute as @a[${ALIVE},${FALLEN}] at @s run function ${NS}:floor/out`,
      `execute as @a[${ALIVE}] unless entity @s[${ROUND}] run tag @s remove ${FF}.alive`,
      `execute store result score #alive ${FF} if entity @a[${ALIVE}]`,
      `execute if score #started ${FF} matches 2.. if score #alive ${FF} matches 1 as @a[${ALIVE}] at @s run function ${NS}:floor/win`,
      `execute if score #started ${FF} matches 2.. if score #alive ${FF} matches 0 run tellraw @a[${ZONE}] "Nobody is left standing, so it’s a draw."`,
      `execute if score #alive ${FF} matches 0 run function ${NS}:floor/end`,
    ],
    'floor/step': CORNERS.map((corner) => `execute positioned ~${corner} run function ${NS}:floor/mark`),
    'floor/mark': FLOORS.flatMap(([, , block]) => [
      `execute if block ~ ~ ~ minecraft:${block} align xyz run summon minecraft:marker ~ ~ ~ {Tags:["${FF}.drop"]}`,
      `execute if block ~ ~ ~ minecraft:${block} run setblock ~ ~ ~ minecraft:red_concrete`,
    ]),
    'floor/out': [
      `tag @s remove ${FF}.alive`,
      `tp @s ${FLOOR_ARRIVAL}`,
      `scoreboard players operation #ticks ${TMP} = @s ${FF}.time`,
      SECONDS,
      `data modify storage ${WORK} finished set from storage ${WORK} new.shown`,
      `execute unless score @s ${FF}.best matches 1.. run return run function ${NS}:floor/best`,
      `execute if score @s ${FF}.time > @s ${FF}.best run return run function ${NS}:floor/best`,
      `scoreboard players operation #ticks ${TMP} = @s ${FF}.best`,
      SECONDS,
      `tellraw @s ["You lasted ",${shown('finished')},". Your best is ",${shown('new.shown')},"."]`,
    ],
    'floor/best': [
      `scoreboard players operation @s ${FF}.best = @s ${FF}.time`,
      `execute store result storage ${WORK} new.score int 1 run scoreboard players get @s ${FF}.best`,
      ...onSidebar(`${FF}.best`),
      submit('ff'),
      `tellraw @s ["You lasted ",${shown('finished')},", your best yet."]`,
    ],
    'floor/win': [
      `scoreboard players add @s ${FF}.wins 1`,
      `execute store result storage ${WORK} new.score int 1 run scoreboard players get @s ${FF}.wins`,
      AS_COUNT,
      submit('wins'),
      `tellraw @a[${ZONE}] [{selector:"@s",color:"gold"}," is the last one standing!"]`,
      `function ${NS}:floor/out`,
      `function ${NS}:floor/end`,
    ],
    'floor/end': [
      `scoreboard players set #state ${FF} 0`,
      `kill @e[type=minecraft:marker,tag=${FF}.drop]`,
      `function ${NS}:floor/rebuild`,
    ],
  },
  load: [
    'forceload add 26 -14 64 14',
    `scoreboard objectives add ${FF} dummy`,
    ...['time', 'age', 'wins'].map((name) => `scoreboard objectives add ${FF}.${name} dummy`),
    `scoreboard objectives add ${FF}.best dummy {text:"Falling floor: longest",color:"yellow",bold:true}`,
    `scoreboard players set #state ${FF} 0`,
    `tag @a remove ${FF}.alive`,
    `team add ${NS}.floor`,
    `team modify ${NS}.floor color yellow`,
    `team modify ${NS}.floor friendlyFire false`,
    `team modify ${NS}.floor collisionRule never`,
    `scoreboard objectives setdisplay sidebar.team.yellow ${FF}.best`,
  ],
  build: [
    // Room around the floors and the lobby on a world that has ground there.
    fill([38, 88, -12], [62, 112, 12], 'air'),
    fill([28, 101, -3], [37, 106, 3], 'air'),
    fill(LOBBY_FROM, LOBBY_TO, 'smooth_stone'),
    fill(BACK_FROM, BACK_TO, 'quartz_block'),
    fill([37, 101, -3], [37, 103, 3], 'glass'),
    `function ${NS}:floor/rebuild`,
    `kill @e[type=minecraft:marker,tag=${FF}.drop]`,
    label(
      '33.5 102.5 2.5',
      `${NS}.label`,
      '["",{text:"Falling floor\\n",color:"yellow",bold:true},"The floor drops away under your feet. Last one standing wins. Wait here for the next round."]',
    ),
    label('29 102 -2', `${NS}.label`, '"Back to the hub"'),
    'forceload remove 26 -14 64 14',
  ],
  tick: [
    `team join ${NS}.floor @a[team=!${NS}.floor,${ZONE}]`,
    `execute as @a[${box(BACK_FROM, [BACK_TO[0], 102, BACK_TO[2]])}] run function ${TO_HUB}`,
    `tp @a[tag=!${FF}.alive,${ARENA}] ${FLOOR_ARRIVAL}`,
    `execute store result score #waiting ${FF} if entity @a[${LOBBY}]`,
    `execute if score #state ${FF} matches 0 if score #waiting ${FF} matches 1.. run scoreboard players set #clock ${FF} ${COUNTDOWN}`,
    `execute if score #state ${FF} matches 0 if score #waiting ${FF} matches 1.. run scoreboard players set #state ${FF} 1`,
    `execute if score #state ${FF} matches 1 run function ${NS}:floor/countdown`,
    `execute if score #state ${FF} matches 2 run title @a[${LOBBY}] actionbar "You’re in the next round"`,
    `execute if score #state ${FF} matches 2 run function ${NS}:floor/round`,
  ],
}
