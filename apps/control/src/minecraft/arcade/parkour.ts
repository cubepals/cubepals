// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's timed parkour, west of the hub: a course of stepping stones with three green
 * checkpoints and a gold finish, a clock that starts as a player steps off the start, and each
 * player's best time, on the hub's board and the sidebar while they are here. Not the board itself
 * (`boards.ts`) or the way here from the hub (`hub.ts`).
 *
 * The clock counts ticks, shown as seconds to a tenth. A fall puts the player back on the last
 * checkpoint they reached with the clock still running, as a timed course does. Leaving for the
 * hub, or stepping back onto the start, ends the run.
 */
import { onSidebar, SECONDS, shown, submit, TMP, WORK } from './boards.ts'
import { type Block, box, fill, label, NS, type Part, TO_HUB } from './datapack.ts'

type Kind = 'stone' | 'checkpoint' | 'finish'

/**
 * The course, as each step's move from the one before: x, y, z. A stone is one block; a checkpoint
 * or the finish is three by three, around the block the move lands on. Every jump is one a player
 * makes at a run: two blocks across on the level, one across going a block up, three across going
 * down (`parkour.test.ts` holds it to that).
 */
const STEPS: ReadonlyArray<readonly [Block, Kind]> = [
  [[-3, 0, 0], 'stone'],
  [[-3, 0, 1], 'stone'],
  [[-2, 1, 0], 'stone'],
  [[-3, 0, -1], 'stone'],
  [[-2, 1, 1], 'stone'],
  [[-3, 0, 0], 'stone'],
  [[-3, -1, -1], 'stone'],
  [[-4, 0, 0], 'checkpoint'],
  [[-4, 0, 0], 'stone'],
  [[-2, 1, -1], 'stone'],
  [[-2, 1, 1], 'stone'],
  [[-3, 0, 1], 'stone'],
  [[-3, 0, -1], 'stone'],
  [[-2, 1, 0], 'stone'],
  [[-3, -1, 2], 'stone'],
  [[-3, 0, 0], 'stone'],
  [[-4, 0, 0], 'checkpoint'],
  [[-4, 0, 1], 'stone'],
  [[-3, 0, -1], 'stone'],
  [[-2, 1, -1], 'stone'],
  [[-2, 1, 0], 'stone'],
  [[-2, 1, 1], 'stone'],
  [[-3, 0, 1], 'stone'],
  [[-3, -2, 0], 'stone'],
  [[-3, 0, -1], 'stone'],
  [[-4, 0, 0], 'checkpoint'],
  [[-4, 0, 0], 'stone'],
  [[-2, 1, 1], 'stone'],
  [[-3, 0, 0], 'stone'],
  [[-2, 1, -1], 'stone'],
  [[-3, 0, -1], 'stone'],
  [[-3, 0, 1], 'stone'],
  [[-4, 0, 0], 'finish'],
]

/** The start: a platform whose west edge the course leaves from, the middle of its edge at y 100. */
const START_EDGE: Block = [-36, 100, 0]
const START_FROM: Block = [-36, 100, -3]
const START_TO: Block = [-28, 100, 3]

/** Where a player arrives from the hub and comes back to: on the start, facing the course. */
export const PARKOUR_ARRIVAL = '-31.5 101 1.5 90 0'

/** The way back to the hub, in the start's north-east corner. */
const BACK_FROM: Block = [-30, 100, -3]
const BACK_TO: Block = [-28, 100, -1]

/** Each step of the course where it is: the block its move lands on, and what it is. */
export const COURSE: ReadonlyArray<{ at: Block; kind: Kind }> = (() => {
  let [x, y, z] = START_EDGE
  return STEPS.map(([[dx, dy, dz], kind]) => {
    ;[x, y, z] = [x + dx, y + dy, z + dz]
    return { at: [x, y, z] as Block, kind }
  })
})()

const CHECKPOINTS = COURSE.filter((step) => step.kind === 'checkpoint').map((step) => step.at)
const FINISH = COURSE.find((step) => step.kind === 'finish')?.at ?? START_EDGE

/** The three by three around a block, and the room above it a player stands in. */
const pad = ([x, y, z]: Block): [Block, Block] => [
  [x - 1, y, z - 1],
  [x + 1, y, z + 1],
]
const above = ([x, y, z]: Block) => box([x - 1, y + 1, z - 1], [x + 1, y + 3, z + 1])

/** Standing on a checkpoint, facing the rest of the course. */
const standOn = ([x, y, z]: Block) => `${x + 0.5} ${y + 1} ${z + 0.5} 90 0`

/** Everything west of the hub's bridge, from below the course to well above it. */
const ZONE = box([-160, 90, -30], [-28, 140, 30])

/** Fallen off the course: below its lowest stone, west of the hub. */
const FELL = box([-160, -128, -30], [-28, 95, 30])

const START = box([START_FROM[0], 101, START_FROM[2]], [START_TO[0], 103, START_TO[2]])
const RUNNING = `tag=${NS}.pk.run`

const BLOCKS: Record<Kind, string> = {
  stone: 'light_blue_concrete',
  checkpoint: 'lime_concrete',
  finish: 'gold_block',
}

const score = (objective: string) => `{score:{name:"@s",objective:"${NS}.pk.${objective}"}}`

export const PARKOUR_PART: Part = {
  functions: {
    'parkour/clock': [
      `scoreboard players operation @s ${NS}.pk.sec = @s ${NS}.pk.time`,
      `scoreboard players operation @s ${NS}.pk.sec /= #20 ${TMP}`,
      `scoreboard players operation @s ${NS}.pk.tenth = @s ${NS}.pk.time`,
      `scoreboard players operation @s ${NS}.pk.tenth %= #20 ${TMP}`,
      `scoreboard players operation @s ${NS}.pk.tenth /= #2 ${TMP}`,
      `title @s actionbar [${score('sec')},".",${score('tenth')},"s"]`,
    ],
    'parkour/fall': [
      `execute unless entity @s[${RUNNING}] run return run tp @s ${PARKOUR_ARRIVAL}`,
      `execute if score @s ${NS}.pk.cp matches 0 run tp @s ${PARKOUR_ARRIVAL}`,
      ...CHECKPOINTS.map(
        (at, i) => `execute if score @s ${NS}.pk.cp matches ${i + 1} run tp @s ${standOn(at)}`,
      ),
    ],
    'parkour/finish': [
      `tag @s remove ${NS}.pk.run`,
      `scoreboard players operation #ticks ${TMP} = @s ${NS}.pk.time`,
      SECONDS,
      `data modify storage ${WORK} finished set from storage ${WORK} new.shown`,
      `tp @s ${PARKOUR_ARRIVAL}`,
      `playsound minecraft:entity.player.levelup master @s`,
      `execute unless score @s ${NS}.pk.best matches 1.. run return run function ${NS}:parkour/best`,
      `execute if score @s ${NS}.pk.time < @s ${NS}.pk.best run return run function ${NS}:parkour/best`,
      `scoreboard players operation #ticks ${TMP} = @s ${NS}.pk.best`,
      SECONDS,
      `tellraw @s ["You finished in ",${shown('finished')},". Your best is ",${shown('new.shown')},"."]`,
    ],
    'parkour/best': [
      `scoreboard players operation @s ${NS}.pk.best = @s ${NS}.pk.time`,
      `scoreboard players set @s ${NS}.pk.side 0`,
      `scoreboard players operation @s ${NS}.pk.side -= @s ${NS}.pk.best`,
      `execute store result storage ${WORK} new.score int -1 run scoreboard players get @s ${NS}.pk.best`,
      ...onSidebar(`${NS}.pk.side`),
      submit('pk'),
      `tellraw @s ["You finished in ",${shown('finished')},", your best yet."]`,
    ],
  },
  load: [
    `forceload add -160 -30 -28 30`,
    ...['time', 'cp', 'best', 'sec', 'tenth'].map(
      (name) => `scoreboard objectives add ${NS}.pk.${name} dummy`,
    ),
    `scoreboard objectives add ${NS}.pk.side dummy {text:"Parkour: fastest",color:"aqua",bold:true}`,
    `team add ${NS}.parkour`,
    `team modify ${NS}.parkour color aqua`,
    `team modify ${NS}.parkour friendlyFire false`,
    `team modify ${NS}.parkour collisionRule never`,
    `scoreboard objectives setdisplay sidebar.team.aqua ${NS}.pk.side`,
  ],
  build: [
    // Room around the course on a world that has ground there; a void world has nothing to clear.
    fill([-140, 90, -5], [-28, 112, 6], 'air'),
    fill(START_FROM, START_TO, 'smooth_stone'),
    fill(BACK_FROM, BACK_TO, 'quartz_block'),
    ...COURSE.map(({ at, kind }) =>
      kind === 'stone'
        ? `setblock ${at.join(' ')} minecraft:${BLOCKS[kind]}`
        : fill(...pad(at), BLOCKS[kind]),
    ),
    label(
      '-32.5 102.5 2.5',
      `${NS}.label`,
      '["",{text:"Parkour\\n",color:"aqua",bold:true},"The clock starts as you step off. Fall, and you’re back on the last green platform."]',
    ),
    label('-29 102 -2', `${NS}.label`, '"Back to the hub"'),
    `forceload remove -160 -30 -28 30`,
  ],
  tick: [
    `team join ${NS}.parkour @a[team=!${NS}.parkour,${ZONE}]`,
    `execute as @a[${box(BACK_FROM, [BACK_TO[0], 102, BACK_TO[2]])}] run function ${TO_HUB}`,
    `execute as @a[${RUNNING}] unless entity @s[${ZONE}] run tag @s remove ${NS}.pk.run`,
    `scoreboard players add @a[${RUNNING}] ${NS}.pk.time 1`,
    `tag @a[${START}] add ${NS}.pk.run`,
    `scoreboard players set @a[${START}] ${NS}.pk.time 0`,
    `scoreboard players set @a[${START}] ${NS}.pk.cp 0`,
    ...CHECKPOINTS.flatMap((at, i) => {
      const reaching = `@a[${RUNNING},scores={${NS}.pk.cp=..${i}},${above(at)}]`
      return [
        `execute as ${reaching} at @s run playsound minecraft:entity.experience_orb.pickup master @s`,
        `tellraw ${reaching} "Checkpoint ${i + 1} of ${CHECKPOINTS.length}."`,
        `scoreboard players set ${reaching} ${NS}.pk.cp ${i + 1}`,
      ]
    }),
    `execute as @a[${RUNNING}] unless entity @s[${START}] run function ${NS}:parkour/clock`,
    `execute as @a[${RUNNING},${above(FINISH)}] at @s run function ${NS}:parkour/finish`,
    `execute as @a[${FELL}] run function ${NS}:parkour/fall`,
  ],
}
