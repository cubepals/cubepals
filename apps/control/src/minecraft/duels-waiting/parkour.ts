// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Duels lobby's timed parkour: two published courses run as one, in stages (the Overcast
 * Community's Parkour: Ice, then Debris), each with the checkpoints its builders set. A player
 * steps onto the yellow pad off the platform's west edge and is put on the first start; the clock
 * starts as they step off it and runs through both. Finishing the first stage sends them to the
 * second's start; finishing the second sends them back to the platform with their time. A fall puts
 * them back on the last checkpoint they reached, the clock still running; a fall before they start,
 * or the green square on the start, takes them back to the platform. Each player's best time goes on
 * the board by the pad and on the sidebar while they are on the course. Not where the courses sit
 * (`maps.ts`) or the rest of the lobby (`duels-waiting.ts`).
 *
 * The places are the courses' own, from each map's `map.xml`, moved to where the course sits.
 */
import { widest } from '../arcade/boards.ts'
import { type Block, box, exactly, type Label, type Part } from '../arcade/datapack.ts'
import { labelIn } from '../arcade/label.ts'
import { leaderboards } from '../leaderboards.ts'
import { NS, placed } from './maps.ts'

/** A box in a map, both corners included, and where a player stands when sent there, facing on. */
interface Spot {
  map: string
  from: Block
  to: Block
  stand: Block
  yaw: number
}

/** Each stage: its start, the checkpoints its builders set, in order, and its finish, in the map. */
const STAGES: ReadonlyArray<{ name: string; start: Spot; checkpoints: readonly Spot[]; finish: Spot }> = [
  {
    name: 'Ice',
    start: { map: 'ice', from: [-117, 1, 8], to: [-114, 3, 10], stand: [-115.5, 1, 9.5], yaw: 180 },
    checkpoints: [
      { map: 'ice', from: [-130, 11, -10], to: [-127, 14, 7], stand: [-128.5, 11, -8.5], yaw: 180 },
      { map: 'ice', from: [-100, 12, -19], to: [-97, 15, -16], stand: [-98.5, 12, -17.5], yaw: 0 },
      { map: 'ice', from: [-120, 20, -4], to: [-117, 23, -1], stand: [-118.5, 20, -2.5], yaw: 180 },
    ],
    finish: { map: 'ice', from: [-120, 21, -15], to: [-117, 24, -12], stand: [-118.5, 21, -13.5], yaw: 0 },
  },
  {
    name: 'Debris',
    start: { map: 'debris', from: [0, 1, -3], to: [2, 3, -1], stand: [1.5, 1, -1.5], yaw: 90 },
    checkpoints: [],
    finish: { map: 'debris', from: [0, 49, -3], to: [2, 50, -2], stand: [1.5, 49, -2], yaw: 90 },
  },
]

const where = (spot: Spot) => `${exactly(placed(spot.map, spot.stand))} ${spot.yaw} 0`
const inside = (spot: Spot) => box(placed(spot.map, spot.from), placed(spot.map, spot.to))

/**
 * Every place a run can go back to, in order: each stage's start, then its checkpoints. A run's
 * `cp` is the index of the last one it reached.
 */
const RESPAWNS: readonly Spot[] = STAGES.flatMap((stage) => [stage.start, ...stage.checkpoints])

const FIRST = STAGES[0]?.start
if (FIRST === undefined) throw new Error('The parkour has no stages')

/** Where a player is put on the first start, facing the course. */
export const PARKOUR_START = where(FIRST)

/** Each stage's finish, beside the platform: the box a player reaches it in. */
export const PARKOUR_FINISHES: ReadonlyArray<{ from: Block; to: Block }> = STAGES.map(({ finish }) => ({
  from: placed(finish.map, finish.from),
  to: placed(finish.map, finish.to),
}))

/** The pad that puts a player on the first start: three by three, off the platform's west edge. */
export const PARKOUR_PAD: { from: Block; to: Block } = { from: [-11, -61, 7], to: [-9, -61, 9] }

/**
 * Where the platform takes a player back to from the course: beside the pad, on the platform,
 * facing it and the board over it.
 */
export const PARKOUR_LOBBY = '-6.5 -60.0 8.5 90 0'

/**
 * The way back at the start: a green square at the back corner of the first start's pad, behind
 * a player arriving, which the welcome to the course points to.
 */
export const START_EXIT: Block = placed('ice', [-117, 0, 10])

/** Both courses and the void under them, to above their highest blocks: a fall is still on the course. */
const ZONE = box([-53, -128, -34], [-14, -10, 19])

/** Fallen off a course: under both, below their lowest blocks. */
const FELL = box([-53, -128, -34], [-14, -63, 19])

/** The players standing on a floor of blocks, as a selector's arguments. */
export const onTop = (from: Block, to: Block): string =>
  box([from[0], from[1] + 1, from[2]], [to[0], to[1] + 1, to[2]])

const START = inside(FIRST)
const RUNNING = `tag=${NS}.pk.run`
const PK = `${NS}.pk`

/** The best times, kept as every Cubepals board is. */
const BOARD = leaderboards(NS, [{ key: 'pk', title: 'Parkour: fastest' }])

/**
 * The board, over the pad and a little beyond it, flat, facing back across the platform: a label
 * as every Cubepals board is (`arcade/label.ts`), empty until its first drawing.
 */
export const BOARD_LABEL: Label = {
  at: [-12.5, -58.4, 8.5],
  tag: `${NS}.board.pk`,
  text: [],
  facing: 'east',
  widest: widest('Parkour: fastest'),
}

const score = (objective: string) => `{score:{name:"@s",objective:"${PK}.${objective}"}}`

/**
 * Reaching each checkpoint, in order: a run that reached the one before it now has this one, said
 * to the player as they reach it.
 */
const checkpointTicks = RESPAWNS.flatMap((spot, i) =>
  STAGES.some((stage) => stage.start === spot)
    ? []
    : [
        `execute as @a[${RUNNING},scores={${PK}.cp=${i - 1}},${inside(spot)}] at @s run function ${NS}:parkour/checkpoint {cp:${i}}`,
      ],
)

/**
 * Finishing a stage: on to the next one's start, or, after the last, the finish. Each is a function
 * run as the player, so the run's checkpoint moves on with them, not before the selector finds them.
 */
const finishTicks = STAGES.map((stage, s) => {
  const last = RESPAWNS.indexOf(stage.checkpoints.at(-1) ?? stage.start)
  const finishing = `@a[${RUNNING},scores={${PK}.cp=${last}},${inside(stage.finish)}]`
  return `execute as ${finishing} at @s run function ${NS}:parkour/${STAGES[s + 1] === undefined ? 'finish' : `stage${s + 2}`}`
})

/** Starting each stage after the first. */
const stageFunctions = Object.fromEntries(
  STAGES.slice(1).map((stage, i) => [
    `parkour/stage${i + 2}`,
    [
      `tellraw @s {text:"Stage ${i + 2} of ${STAGES.length}: ${stage.name}",bold:true}`,
      'playsound minecraft:entity.player.levelup master @s',
      `scoreboard players set @s ${PK}.cp ${RESPAWNS.indexOf(stage.start)}`,
      `tp @s ${where(stage.start)}`,
    ],
  ]),
)

export const PARKOUR_PART: Part = {
  functions: {
    ...BOARD.functions,
    ...stageFunctions,
    'parkour/checkpoint': [
      'playsound minecraft:entity.experience_orb.pickup master @s',
      'tellraw @s {text:"Checkpoint",color:"gray"}',
      `$scoreboard players set @s ${PK}.cp $(cp)`,
    ],
    'parkour/arrive': [
      `tp @s ${PARKOUR_START}`,
      `tellraw @s ["",{text:"Parkour: ",bold:true},"two courses against the clock, which starts as you step off. Falling puts you back on your last checkpoint. The green square behind you goes back."]`,
    ],
    'parkour/back': [`tag @s remove ${NS}.pk.run`, `tp @s ${PARKOUR_LOBBY}`],
    'parkour/clock': [
      `scoreboard players operation @s ${PK}.sec = @s ${PK}.time`,
      `scoreboard players operation @s ${PK}.sec /= #20 ${BOARD.TMP}`,
      `scoreboard players operation @s ${PK}.tenth = @s ${PK}.time`,
      `scoreboard players operation @s ${PK}.tenth %= #20 ${BOARD.TMP}`,
      `scoreboard players operation @s ${PK}.tenth /= #2 ${BOARD.TMP}`,
      `title @s actionbar [${score('sec')},".",${score('tenth')},"s"]`,
    ],
    'parkour/fall': [
      `execute unless entity @s[${RUNNING}] run return run function ${NS}:parkour/back`,
      ...RESPAWNS.map((spot, i) => `execute if score @s ${PK}.cp matches ${i} run tp @s ${where(spot)}`),
    ],
    'parkour/finish': [
      `tag @s remove ${NS}.pk.run`,
      `scoreboard players operation #ticks ${BOARD.TMP} = @s ${PK}.time`,
      BOARD.SECONDS,
      `data modify storage ${BOARD.WORK} finished set from storage ${BOARD.WORK} new.shown`,
      `tp @s ${PARKOUR_LOBBY}`,
      'playsound minecraft:ui.toast.challenge_complete master @s',
      `execute unless score @s ${PK}.best matches 1.. run return run function ${NS}:parkour/best`,
      `execute if score @s ${PK}.time < @s ${PK}.best run return run function ${NS}:parkour/best`,
      `scoreboard players operation #ticks ${BOARD.TMP} = @s ${PK}.best`,
      BOARD.SECONDS,
      `tellraw @s ["You finished the parkour in ",${BOARD.shown('finished')},". Your best is ",${BOARD.shown('new.shown')},"."]`,
    ],
    'parkour/best': [
      `scoreboard players operation @s ${PK}.best = @s ${PK}.time`,
      `scoreboard players set @s ${PK}.side 0`,
      `scoreboard players operation @s ${PK}.side -= @s ${PK}.best`,
      `execute store result storage ${BOARD.WORK} new.score int -1 run scoreboard players get @s ${PK}.best`,
      ...BOARD.onSidebar(`${PK}.side`),
      BOARD.submit('pk'),
      `tellraw @s ["You finished the parkour in ",${BOARD.shown('finished')},", your best yet."]`,
    ],
  },
  load: [
    ...BOARD.load,
    ...['time', 'cp', 'best', 'sec', 'tenth'].map((name) => `scoreboard objectives add ${PK}.${name} dummy`),
    `scoreboard objectives add ${PK}.side dummy {text:"Parkour: fastest",color:"aqua",bold:true}`,
    `team add ${NS}.parkour`,
    `team modify ${NS}.parkour color aqua`,
    `team modify ${NS}.parkour collisionRule never`,
    `team modify ${NS}.parkour nametagVisibility hideForOtherTeams`,
    `scoreboard objectives setdisplay sidebar.team.aqua ${PK}.side`,
  ],
  build: [
    `fill ${PARKOUR_PAD.from.join(' ')} ${PARKOUR_PAD.to.join(' ')} minecraft:yellow_concrete`,
    `setblock ${START_EXIT.join(' ')} minecraft:lime_concrete`,
    `kill @e[type=minecraft:text_display,tag=${NS}.display]`,
    ...labelIn(BOARD_LABEL, NS),
    ...BOARD.build,
  ],
  tick: [
    `team join ${NS}.parkour @a[team=!${NS}.parkour,${ZONE}]`,
    `execute as @a[team=${NS}.parkour] unless entity @s[${ZONE}] run team leave @s`,
    `execute as @a[gamemode=!spectator] at @s if block ~ ~-1 ~ minecraft:yellow_concrete if entity @s[${onTop(PARKOUR_PAD.from, PARKOUR_PAD.to)}] run function ${NS}:parkour/arrive`,
    `execute as @a[${RUNNING}] unless entity @s[${ZONE}] run tag @s remove ${NS}.pk.run`,
    `scoreboard players add @a[${RUNNING}] ${PK}.time 1`,
    `tag @a[${START}] add ${NS}.pk.run`,
    `scoreboard players set @a[${START}] ${PK}.time 0`,
    `scoreboard players set @a[${START}] ${PK}.cp 0`,
    ...checkpointTicks,
    ...finishTicks,
    `execute as @a[${RUNNING}] unless entity @s[${START}] run function ${NS}:parkour/clock`,
    `execute as @a[gamemode=!spectator,${FELL}] run function ${NS}:parkour/fall`,
    `execute as @a[gamemode=!spectator] at @s if block ~ ~-1 ~ minecraft:lime_concrete if entity @s[${onTop(START_EXIT, START_EXIT)}] run function ${NS}:parkour/back`,
  ],
  data: BOARD.data,
}
