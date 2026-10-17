// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's falling floor, on NetherGames' MD-Meltdown: five round floors of snow stacked over a
 * frozen lake, whose blocks turn to ice under a player's feet and drop a moment later. Players wait
 * for a round on the pad at the lake's edge; a round starts ten seconds after someone is waiting,
 * with everyone waiting by then, on the top floor. With two or more, the last one standing wins,
 * and the last two falling together is a draw; alone, it is how long you last. Both are kept: the
 * longest anyone lasted, and wins. Each round's floors are put back from an untouched copy the
 * world keeps out of sight (`FLOOR_STORE`). Not the boards (`boards.ts`) or the way here (`hub.ts`).
 *
 * A round is `#state` in its objective: 0 nobody waiting, 1 counting down, 2 under way.
 */
import { type Read, viewFrom } from '../readable.ts'
import { AS_COUNT, onSidebar, SECONDS, shown, submit, TMP, WORK } from './boards.ts'
import { type Block, box, NS, PAPER, type Part } from './datapack.ts'
import { type BrandSign, buildSign, creditLabel, ICE } from './signs.ts'

const FF = `${NS}.ff`

/** The box that holds the five floors, in the Arcade's world: MD-Meltdown's arena, radius 40. */
export const FLOOR_DISC = { from: [-45, 67, -45] as Block, to: [45, 99, 45] as Block }

/** How far from the floors their untouched copy is kept, out of sight; a round puts them back from it. */
export const FLOOR_STORE: Block = [0, 0, 700]

/** The floors' heights, top first, as MD-Meltdown's `arenas.yml` lists them, and their block. */
const FLOOR_YS = [99, 91, 83, 75, 67]
const FLOOR_BLOCK = 'snow_block'

/** Where a player arrives from the hub, and goes back to between rounds: the pad at the lake's edge, facing the floors. */
export const FLOOR_ARRIVAL = '0.5 60 52.5 180 0'

/**
 * What to do here, read on arriving at the pad: one line between the pad and the floors, over the
 * lake's headroom and short of the floors (`readable.ts`). The title on arriving names the game.
 */
export const FLOOR_READS: readonly Read[] = [
  {
    label: {
      at: [0.5, 63.08, 46.5],
      tag: `${NS}.label`,
      text: [{ text: 'Wait here for the next round', color: PAPER }],
      scale: 1,
      facing: 'south',
    },
    from: viewFrom(FLOOR_ARRIVAL),
    titled: true,
  },
]

/** The pad players wait on, built into the world (`scripts/lib/arcade-brand.ts`), by its middle. */
export const FLOOR_PAD: Block = [0, 59, 52]

/** How long a block stays ice under a player before it drops, in ticks. */
const DROP_AFTER = 8

/** How long the countdown to a round is, in ticks: ten seconds. */
const COUNTDOWN = 200

/** Waiting on the pad; a moderator watching in spectator mode isn't. */
const LOBBY = `${box([FLOOR_PAD[0] - 2, 60, FLOOR_PAD[2] - 2], [FLOOR_PAD[0] + 2, 62, FLOOR_PAD[2] + 2])},gamemode=!spectator`
/** Over the floors: nobody is here but who is playing the round. */
const ARENA = box([-41, 66, -41], [41, 120, 41])
/** Out: through the bottom floor, onto the lake under the arena. */
const OUT = box([-41, -128, -41], [41, 65, 41])
/** Where a player in a round may be; one anywhere else has left the round. */
const ROUND = box([-45, -128, -45], [45, 140, 45])
const ZONE = box([-170, 20, -170], [170, 180, 170])
const ALIVE = `tag=${FF}.alive`

/** The four corners under a player's feet, so a block they only half stand on drops too. */
const CORNERS = ['0.3 ~-0.5 ~0.3', '-0.3 ~-0.5 ~0.3', '0.3 ~-0.5 ~-0.3', '-0.3 ~-0.5 ~-0.3']

const [x0, , z0] = FLOOR_DISC.from
const [x1, , z1] = FLOOR_DISC.to
const [sx, , sz] = FLOOR_STORE

/** The small Cubepals sign between the pad and the floors, facing a player on the pad, in ice. */
export const FLOOR_SIGN: BrandSign = {
  at: [-2, 68, 47],
  side: 4,
  facing: 'south',
  frame: ICE,
  credit: 'meltdown',
}

export const FLOOR_PART: Part = {
  functions: {
    // Each floor from its copy: where the copy has snow, so is the floor again.
    'floor/rebuild': FLOOR_YS.map(
      (y) => `clone ${x0 + sx} ${y} ${z0 + sz} ${x1 + sx} ${y} ${z1 + sz} ${x0} ${y} ${z0} masked`,
    ),
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
      `spreadplayers 0 0 4 30 under 101 false @a[${ALIVE}]`,
      `tp @a[${ALIVE},${LOBBY}] 0.5 100 0.5`,
      `scoreboard players set #state ${FF} 2`,
      `tellraw @a[${ALIVE}] "Go! The floor drops away wherever you step, so keep moving."`,
    ],
    'floor/round': [
      `scoreboard players add @a[${ALIVE}] ${FF}.time 1`,
      `execute as @a[${ALIVE}] at @s run function ${NS}:floor/step`,
      `scoreboard players add @e[type=minecraft:marker,tag=${FF}.drop] ${FF}.age 1`,
      `execute as @e[type=minecraft:marker,tag=${FF}.drop,scores={${FF}.age=${DROP_AFTER}..}] at @s run setblock ~ ~ ~ minecraft:air`,
      `kill @e[type=minecraft:marker,tag=${FF}.drop,scores={${FF}.age=${DROP_AFTER}..}]`,
      `execute as @a[${ALIVE},${OUT}] at @s run function ${NS}:floor/out`,
      `execute as @a[${ALIVE}] unless entity @s[${ROUND}] run tag @s remove ${FF}.alive`,
      `execute store result score #alive ${FF} if entity @a[${ALIVE}]`,
      `execute if score #started ${FF} matches 2.. if score #alive ${FF} matches 1 as @a[${ALIVE}] at @s run function ${NS}:floor/win`,
      `execute if score #started ${FF} matches 2.. if score #alive ${FF} matches 0 run tellraw @a[${ZONE}] "Nobody is left standing, so it’s a draw."`,
      `execute if score #alive ${FF} matches 0 run function ${NS}:floor/end`,
    ],
    'floor/step': CORNERS.map((corner) => `execute positioned ~${corner} run function ${NS}:floor/mark`),
    'floor/mark': [
      `execute if block ~ ~ ~ minecraft:${FLOOR_BLOCK} align xyz run summon minecraft:marker ~ ~ ~ {Tags:["${FF}.drop"]}`,
      `execute if block ~ ~ ~ minecraft:${FLOOR_BLOCK} run setblock ~ ~ ~ minecraft:packed_ice`,
    ],
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
      `tellraw @a[${ZONE}] [{selector:"@s",color:"${PAPER}",bold:true}," is the last one standing!"]`,
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
    // The floors, their pad and their copy stay loaded, so a round puts them back wherever its
    // players are.
    `forceload add ${x0} ${z0} ${x1} ${Math.max(z1, FLOOR_PAD[2] + 2)}`,
    `forceload add ${x0 + sx} ${z0 + sz} ${x1 + sx} ${z1 + sz}`,
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
  labels: [
    ...FLOOR_READS.map(({ label }) => label),
    ...[creditLabel(FLOOR_SIGN)].filter((credit) => credit !== null),
  ],
  build: [
    ...buildSign(FLOOR_SIGN),
    `function ${NS}:floor/rebuild`,
    `kill @e[type=minecraft:marker,tag=${FF}.drop]`,
  ],
  tick: [
    `team join ${NS}.floor @a[team=!${NS}.floor,${ZONE}]`,
    `tp @a[tag=!${FF}.alive,gamemode=!spectator,${ARENA}] ${FLOOR_ARRIVAL}`,
    `execute store result score #waiting ${FF} if entity @a[${LOBBY}]`,
    `execute if score #state ${FF} matches 0 if score #waiting ${FF} matches 1.. run scoreboard players set #clock ${FF} ${COUNTDOWN}`,
    `execute if score #state ${FF} matches 0 if score #waiting ${FF} matches 1.. run scoreboard players set #state ${FF} 1`,
    `execute if score #state ${FF} matches 1 run function ${NS}:floor/countdown`,
    `execute if score #state ${FF} matches 2 run title @a[${LOBBY}] actionbar "You’re in the next round"`,
    `execute if score #state ${FF} matches 2 run function ${NS}:floor/round`,
  ],
}
