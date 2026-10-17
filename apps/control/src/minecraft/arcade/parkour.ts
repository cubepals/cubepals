// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's timed parkour: three published courses run as one, in stages (Overcast's Parkour:
 * Jungle, Ice and Debris), each with the checkpoints its builders set. The clock starts as a player
 * steps off the first start and runs through all three; finishing a stage sends them to the next
 * one's start. A fall puts them back on the last checkpoint they reached, the clock still running,
 * as a timed course does. Each player's best time goes on the hub's board and on the sidebar while
 * they are here. Not the board itself (`boards.ts`) or the way here from the hub (`hub.ts`).
 *
 * The places are the courses' own, from each map's `map.xml`, moved to where the course sits in
 * the Arcade's world (`maps.ts`).
 */
import { type Read, viewFrom } from '../readable.ts'
import { onSidebar, SECONDS, shown, submit, TMP, WORK } from './boards.ts'
import { type Block, box, NS, PAPER, type Part, titled } from './datapack.ts'
import { placed } from './maps.ts'
import { clearSign, type SignPlace } from './signs.ts'

/** A box in a map, both corners included, and where a player stands when sent there, facing on. */
interface Spot {
  map: string
  from: Block
  to: Block
  stand: Block
  yaw: number
}

/**
 * The Jungle's finish: a small mossy pad where its last jumps land, in the map's own terms. The
 * course ended on top of a statue of a player, which the build takes out and puts this in place of
 * (`scripts/lib/arcade-likeness.ts`).
 */
export const JUNGLE_PAD: { from: Block; to: Block } = { from: [-3, 23, -27], to: [-1, 23, -25] }

/** Each stage: its start, the checkpoints its builders set, in order, and its finish. */
const STAGES: ReadonlyArray<{
  name: string
  start: Spot
  checkpoints: readonly Spot[]
  finish: { from: Block; to: Block }
}> = [
  {
    name: 'Jungle',
    start: { map: 'jungle', from: [-1, 1, -1], to: [1, 3, 1], stand: [0.5, 1, 0.5], yaw: 90 },
    checkpoints: [
      { map: 'jungle', from: [3, 14, -2], to: [6, 16, 1], stand: [4.5, 14, -0.5], yaw: 90 },
      { map: 'jungle', from: [-21, 17, 16], to: [-18, 19, 19], stand: [-19.5, 17, 17.5], yaw: -90 },
    ],
    finish: {
      from: placed('jungle', [JUNGLE_PAD.from[0], JUNGLE_PAD.from[1] + 1, JUNGLE_PAD.from[2]]),
      to: placed('jungle', [JUNGLE_PAD.to[0], JUNGLE_PAD.to[1] + 2, JUNGLE_PAD.to[2]]),
    },
  },
  {
    name: 'Ice',
    start: { map: 'ice', from: [-117, 1, 8], to: [-114, 3, 10], stand: [-115.5, 1, 9], yaw: 180 },
    checkpoints: [
      { map: 'ice', from: [-130, 11, -10], to: [-127, 14, 7], stand: [-128.5, 11, -8.5], yaw: 180 },
      { map: 'ice', from: [-100, 12, -19], to: [-97, 15, -16], stand: [-98.5, 12, -17.5], yaw: 0 },
      { map: 'ice', from: [-120, 20, -4], to: [-117, 23, -1], stand: [-118.5, 20, -2.5], yaw: 180 },
    ],
    finish: { from: placed('ice', [-120, 21, -15]), to: placed('ice', [-117, 24, -12]) },
  },
  {
    name: 'Debris',
    start: { map: 'debris', from: [0, 1, -3], to: [2, 3, -1], stand: [1.5, 1, -1.5], yaw: 90 },
    checkpoints: [],
    finish: { from: placed('debris', [0, 49, -3]), to: placed('debris', [2, 50, -2]) },
  },
]

const where = (spot: Spot) => {
  const [x, y, z] = placed(spot.map, spot.stand)
  return `${x} ${y} ${z} ${spot.yaw} 0`
}
const inside = (spot: Spot) => box(placed(spot.map, spot.from), placed(spot.map, spot.to))

/**
 * Every place a run can go back to, in order: each stage's start, then its checkpoints. A run's
 * `cp` is the index of the last one it reached.
 */
const RESPAWNS: readonly Spot[] = STAGES.flatMap((stage) => [stage.start, ...stage.checkpoints])

/** Each stage's finish, in the Arcade's world: the box a player reaches it in. */
export const PARKOUR_FINISHES: ReadonlyArray<{ from: Block; to: Block }> = STAGES.map((stage) => stage.finish)

/** Where a player arrives from the hub and comes back to: the first start, facing the course. */
const FIRST = STAGES[0]?.start ?? RESPAWNS[0]
if (FIRST === undefined) throw new Error('The parkour has no stages')
export const PARKOUR_ARRIVAL = where(FIRST)

/**
 * What to do here, read on arriving: beyond the Jungle's far end, past all of its jumps, over a
 * look ahead, clear of the first stairs in front of it and of the title the arrival shows, large
 * enough to read from there (`readable.ts`).
 */
export const PARKOUR_READS: readonly Read[] = [
  {
    label: {
      at: [968.5, 73.8, 0.5],
      tag: `${NS}.label`,
      text: titled('Parkour', 'Step off to start the clock'),
      scale: 5,
      facing: 'east',
    },
    from: viewFrom(PARKOUR_ARRIVAL),
    titled: true,
  },
]

/** Everything the courses take up, from below them to well above. */
const ZONE = box([940, 40, -60], [1460, 140, 60])

/** Fallen off a course: below its lowest blocks. */
const FELL = box([940, -128, -60], [1460, 63, 60])

const START = inside(FIRST)
const RUNNING = `tag=${NS}.pk.run`
const PK = `${NS}.pk`

const score = (objective: string) => `{score:{name:"@s",objective:"${PK}.${objective}"}}`

/** Reaching each checkpoint, in order: a run that reached the one before it now has this one. */
const checkpointTicks = RESPAWNS.flatMap((spot, i) => {
  if (STAGES.some((stage) => stage.start === spot)) return []
  const reaching = `@a[${RUNNING},scores={${PK}.cp=${i - 1}},${inside(spot)}]`
  return [
    `execute as ${reaching} at @s run playsound minecraft:entity.experience_orb.pickup master @s`,
    `tellraw ${reaching} {text:"Checkpoint",color:"gray"}`,
    `scoreboard players set ${reaching} ${PK}.cp ${i}`,
  ]
})

/** Finishing a stage: on to the next one's start, or, after the last, the finish. */
const finishTicks = STAGES.flatMap((stage, s) => {
  const last = RESPAWNS.indexOf(stage.checkpoints.at(-1) ?? stage.start)
  const finishing = `@a[${RUNNING},scores={${PK}.cp=${last}},${box(stage.finish.from, stage.finish.to)}]`
  const next = STAGES[s + 1]
  if (next === undefined) return [`execute as ${finishing} at @s run function ${NS}:parkour/finish`]
  return [
    `tellraw ${finishing} ["",{text:"Stage ${s + 2} of ${STAGES.length}: ${next.name}",color:"${PAPER}",bold:true}]`,
    `execute as ${finishing} at @s run playsound minecraft:entity.player.levelup master @s`,
    `scoreboard players set ${finishing} ${PK}.cp ${RESPAWNS.indexOf(next.start)}`,
    `tp ${finishing} ${where(next.start)}`,
  ]
})

/**
 * Where a Cubepals sign once stood, in jungle wood, over the first course's stairs, which it shut:
 * taken down as the datapack builds, the open air it stood in left clear.
 */
const OLD_SIGN: SignPlace = { at: [994, 72, 2], side: 4, facing: 'east' }

export const PARKOUR_PART: Part = {
  functions: {
    'parkour/clock': [
      `scoreboard players operation @s ${PK}.sec = @s ${PK}.time`,
      `scoreboard players operation @s ${PK}.sec /= #20 ${TMP}`,
      `scoreboard players operation @s ${PK}.tenth = @s ${PK}.time`,
      `scoreboard players operation @s ${PK}.tenth %= #20 ${TMP}`,
      `scoreboard players operation @s ${PK}.tenth /= #2 ${TMP}`,
      `title @s actionbar [${score('sec')},".",${score('tenth')},"s"]`,
    ],
    'parkour/fall': [
      `execute unless entity @s[${RUNNING}] run return run tp @s ${PARKOUR_ARRIVAL}`,
      ...RESPAWNS.map((spot, i) => `execute if score @s ${PK}.cp matches ${i} run tp @s ${where(spot)}`),
    ],
    'parkour/finish': [
      `tag @s remove ${NS}.pk.run`,
      `scoreboard players operation #ticks ${TMP} = @s ${PK}.time`,
      SECONDS,
      `data modify storage ${WORK} finished set from storage ${WORK} new.shown`,
      `tp @s ${PARKOUR_ARRIVAL}`,
      `playsound minecraft:ui.toast.challenge_complete master @s`,
      `execute unless score @s ${PK}.best matches 1.. run return run function ${NS}:parkour/best`,
      `execute if score @s ${PK}.time < @s ${PK}.best run return run function ${NS}:parkour/best`,
      `scoreboard players operation #ticks ${TMP} = @s ${PK}.best`,
      SECONDS,
      `tellraw @s ["You finished all three in ",${shown('finished')},". Your best is ",${shown('new.shown')},"."]`,
    ],
    'parkour/best': [
      `scoreboard players operation @s ${PK}.best = @s ${PK}.time`,
      `scoreboard players set @s ${PK}.side 0`,
      `scoreboard players operation @s ${PK}.side -= @s ${PK}.best`,
      `execute store result storage ${WORK} new.score int -1 run scoreboard players get @s ${PK}.best`,
      ...onSidebar(`${PK}.side`),
      submit('pk'),
      `tellraw @s ["You finished all three in ",${shown('finished')},", your best yet."]`,
    ],
  },
  load: [
    'forceload add 960 -40 1410 40',
    ...['time', 'cp', 'best', 'sec', 'tenth'].map((name) => `scoreboard objectives add ${PK}.${name} dummy`),
    `scoreboard objectives add ${PK}.side dummy {text:"Parkour: fastest",color:"aqua",bold:true}`,
    `team add ${NS}.parkour`,
    `team modify ${NS}.parkour color aqua`,
    `team modify ${NS}.parkour friendlyFire false`,
    `team modify ${NS}.parkour collisionRule never`,
    `team modify ${NS}.parkour nametagVisibility hideForOtherTeams`,
    `scoreboard objectives setdisplay sidebar.team.aqua ${PK}.side`,
  ],
  labels: PARKOUR_READS.map(({ label }) => label),
  build: [clearSign(OLD_SIGN), 'forceload remove 960 -40 1410 40'],
  tick: [
    `team join ${NS}.parkour @a[team=!${NS}.parkour,${ZONE}]`,
    `execute as @a[${RUNNING}] unless entity @s[${ZONE}] run tag @s remove ${NS}.pk.run`,
    `scoreboard players add @a[${RUNNING}] ${PK}.time 1`,
    `tag @a[${START}] add ${NS}.pk.run`,
    `scoreboard players set @a[${START}] ${PK}.time 0`,
    `scoreboard players set @a[${START}] ${PK}.cp 0`,
    ...checkpointTicks,
    ...finishTicks,
    `execute as @a[${RUNNING}] unless entity @s[${START}] run function ${NS}:parkour/clock`,
    `execute as @a[gamemode=!spectator,${FELL}] run function ${NS}:parkour/fall`,
  ],
}
