// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's hub: NetherGames' ArcadeLobby, a hall of arcade cabinets in Cubepals' colours,
 * buried in the ground, and the house from cubepals.com's landing page on the grass over it, where
 * everyone starts; a few steps down from its floor and on through a doorway is the end of the
 * hall's west corridor, which leads onto the balcony. There, a black pad for each game sends a
 * player to it, its name over it, with the boards in front of the balcony's domes, the Cubepals
 * sign over the ARCADE cabinet, the welcome and the credits. It is also the way back: the "Back to
 * the hub" item every player carries, `/trigger hub`, a fall, dying, and coming back
 * after leaving. Not the games or what their boards hold, which are their own.
 *
 * It also holds the world's rules for an arcade, in a function of their own (`arcade:rules`): no
 * monsters, no night or rain, no fall damage, no chat about advancements, and everyone spawning in
 * the house. Game rules are renamed between releases, so a release that knows them by other
 * names fails that function alone.
 */

import { MARKERS, type ShownMarker, showMarker } from '../brand-pack.ts'
import { CABINET } from '../marquee.ts'
import { lookingAt, type Read } from '../readable.ts'
import { TMP } from './boards.ts'
import { CREDIT_LINES } from './credits.ts'
import {
  type Block,
  box,
  FALLEN,
  type Facing,
  HUB_SPAWN,
  type Label,
  NS,
  PAPER,
  type Part,
  TO_HUB,
  titled,
} from './datapack.ts'
import { plateOf } from './label-space.ts'
import { type BrandSign, buildSign } from './signs.ts'
import { GAMES, playing } from './ways-in.ts'

const HUB = `${NS}.hub`

/**
 * The Cubepals sign on the big ARCADE cabinet, facing the hall, over its name: its base the front
 * of the cabinet's roof, as high as the hall's ceiling lets it be, in the cabinets' own lights.
 */
export const HUB_SIGN: BrandSign = { at: [173, 111, 1363], side: 6, facing: 'south', frame: CABINET }

/** The plain Paper the sign over the cabinet once hung on, further back on its roof, taken away. */
const OLD_BACKING = 'fill 165 107 1358 184 110 1358 minecraft:air replace minecraft:quartz_block'

/** What a player types after `/trigger` to come back, or to read who made the maps. */
const BACK = 'hub'
const CREDITS = 'credits'

/**
 * Each game's pad on the balcony, by the block at its middle: Ink in a ring of Paper, built into
 * the world (`scripts/lib/arcade-brand.ts`), and what standing on it does (`ways-in.ts`).
 */
export const PADS: ReadonlyArray<{ middle: Block; sends: string }> = GAMES.map((game) => ({
  middle: game.pad,
  sends: playing(game),
}))

/** The top step of the stairs from the house's floor, which a sign floats over. */
export const STAIRS_TOP: Block = [183, 121, 1459]

/**
 * The way between the house and the hall, which lies far deeper than a few steps: at the foot of
 * the house's stairs, a doorway; at the end of the hall's west corridor, another. Walking on
 * through one (into the box at its far side) arrives just past the other, facing on. Both are
 * built as rooms of their own (`scripts/lib/arcade-house.ts`).
 */
export const PASSAGE = {
  house: {
    through: [
      [168, 117, 1459],
      [168, 118, 1460],
    ] as [Block, Block],
    arrive: '176.5 117 1460 -90 0',
  },
  hall: {
    through: [
      [137, 78, 1460],
      [139, 79, 1460],
    ] as [Block, Block],
    arrive: '138.5 78 1452.5 180 0',
  },
} as const

/** The hall, the ground it is buried in, and the house and garden on the grass. */
const ZONE = box([96, 40, 1336], [260, 140, 1470])

const welcome = `["",{text:"Welcome to the Cubepals Arcade. ",color:"${PAPER}",bold:true},"See if you can get your name on the boards."]`

/** Whose maps these are, told with the welcome: the maps' licences ask for it to be said. */
const CREDITS_LINE = `["",{text:"Made of maps by NetherGames and the Overcast community. ",color:"gray"},{text:"Type /trigger credits",color:"${PAPER}"},{text:" for who built each one.",color:"gray"}]`

/** How to start a game, told on each arrival at the hub: on joining, and on coming back from anywhere. */
export const HINT = 'Open the book to pick a game, or walk into a game’s machine in the hall.'

/** Every how many ticks the pads sparkle. */
const GLOW_EVERY = 10

/** How far out from a wall what is flat on it stands: no block face in front of it, nor a gap to see. */
const OFF_WALL = 0.05

/**
 * Each doorway between the house and the hall ends at a wall: walking up to it is walking on
 * through (`PASSAGE`). Flat on that wall, just off it, are an open door and where it goes, one over
 * the other, a little under the game's size, centred on the wall's face: two blocks across in the
 * house, between the doorway's frame, and three in the hall, from the floor up three.
 */
const ENDS: ReadonlyArray<{ x: number; floor: number; z: number; facing: Facing; to: string }> = [
  { x: 168 + OFF_WALL, floor: PASSAGE.house.through[0][1], z: 1460, facing: 'east', to: 'The Arcade' },
  { x: 138.5, floor: PASSAGE.hall.through[0][1], z: 1461 - OFF_WALL, facing: 'north', to: 'The house' },
]
const END_SCALE = 0.8

/** The open door flat on the wall at each passage's end. */
export const HUB_MARKERS: readonly ShownMarker[] = [
  ...ENDS.map(({ x, floor, z, facing }) => ({
    marker: MARKERS.wayOut,
    at: [x, floor + 1.25, z] as const,
    facing,
    scale: END_SCALE,
  })),
]

/**
 * Over each game's pad, its name and what to do, read as a player walks the balcony toward it from
 * the corridor in from the house: turning to them, just over the reach of anyone standing on the
 * pad (1.8 blocks tall and a 1.2522-block jump), and large enough to read from where it is first
 * seen (`readable.ts`). The pit's pad stands back in its dome, so it is read from further away,
 * and its words are larger to look as large from there as the others do from theirs.
 */
const PAD_READ_FROM: Readonly<Record<string, Block>> = {
  parkour: [134.5, 78, 1431.5],
  pit: [163.5, 78, 1432.5],
  floor: [216.5, 78, 1431.5],
}
const OVER_REACH = 1 + 1.8 + 1.2522 + 0.05
export const PAD_READS: readonly Read[] = GAMES.map((game) => {
  const [x, y, z] = game.pad
  const words = { text: titled(game.name, 'Stand here to play'), scale: game.key === 'pit' ? 2.2 : 1.3 }
  // The plate reaches a little under the words: it is the plate's foot that clears the reach.
  const at: [number, number, number] = [x + 0.5, y + OVER_REACH - plateOf(words).bottom, z + 0.5]
  const from = PAD_READ_FROM[game.key]
  if (from === undefined) throw new Error(`No place to read ${game.key}'s pad from`)
  return {
    label: { at, tag: `${NS}.label`, ...words },
    from: lookingAt(from, at),
  }
})

/**
 * Every label in the hub: its name and the ways between the house and the hall. None stands where
 * players walk or jump (`scripts/play-space.test.ts`): what the credits said from the balcony's
 * floor is told on arriving instead (`CREDITS_LINE`).
 */
const HUB_LABELS: readonly Label[] = [
  ...PAD_READS.map(({ label }) => label),
  {
    at: [175.5, 98.2, 1444.5],
    tag: `${NS}.label`,
    text: [{ text: 'Cubepals Arcade', color: PAPER, bold: true }],
    scale: 4,
  },
  // On the house's west wall by the top of the stairs, facing a player as they start: in the
  // middle of the wall's face, four blocks across from the house's south wall to its north, and
  // three high from the floor.
  {
    at: [STAIRS_TOP[0] - 3 + OFF_WALL, STAIRS_TOP[1] + 3.225, STAIRS_TOP[2]],
    tag: `${NS}.label`,
    text: titled('The Arcade', 'Down the stairs'),
    facing: 'east',
  },
  ...ENDS.map(({ x, floor, z, facing, to }) => ({
    at: [x, floor + 1.75, z] as const,
    tag: `${NS}.label`,
    text: titled(to, 'Walk on through'),
    scale: END_SCALE,
    facing,
  })),
]

export const HUB_PART: Part = {
  functions: {
    'hub/back': [
      `scoreboard players reset @s ${BACK}`,
      `scoreboard players reset @s ${NS}.left`,
      `scoreboard players reset @s ${NS}.back`,
      `scoreboard players reset @s ${NS}.died`,
      `tp @s ${HUB_SPAWN}`,
      `tellraw @s {text:${JSON.stringify(HINT)},color:"gray"}`,
    ],
    // A few sparks rising off each pad, so it reads as somewhere to stand.
    'hub/glow': [
      `scoreboard players set #glow ${TMP} 0`,
      ...GAMES.map(
        ({ pad: [x, y, z] }) =>
          `particle minecraft:end_rod ${x + 0.5} ${y + 1.2} ${z + 0.5} 0.8 0.1 0.8 0.01 2 normal`,
      ),
    ],
    'hub/credits': [
      `scoreboard players reset @s ${CREDITS}`,
      ...CREDIT_LINES.map((line) => `tellraw @s ${line}`),
    ],
    rules: [
      'gamerule advance_time false',
      'gamerule advance_weather false',
      'gamerule spawn_monsters false',
      'gamerule spawn_mobs false',
      'gamerule fall_damage false',
      'gamerule immediate_respawn true',
      'gamerule respawn_radius 0',
      'gamerule show_advancement_messages false',
      'time set noon',
      'weather clear',
      // The block of `HUB_SPAWN`, facing the same way.
      'setworldspawn 182 122 1458 90 0',
    ],
  },
  load: [
    'forceload add 96 1336 260 1470',
    `scoreboard objectives add ${BACK} trigger`,
    `scoreboard objectives add ${CREDITS} trigger`,
    `scoreboard objectives add ${NS}.left minecraft.custom:minecraft.leave_game`,
    `scoreboard objectives add ${NS}.back minecraft.used:minecraft.carrot_on_a_stick`,
    `scoreboard objectives add ${NS}.died deathCount`,
    `scoreboard objectives add ${NS}.food food`,
    `team add ${HUB}`,
    `team modify ${HUB} friendlyFire false`,
    `team modify ${HUB} collisionRule never`,
  ],
  labels: HUB_LABELS,
  build: [
    ...HUB_MARKERS.map((marker) => showMarker(marker, [`${NS}.display`])),
    OLD_BACKING,
    ...buildSign(HUB_SIGN),
    // Nothing in the hub can be hurt: whatever the maps brought along, and what the build made.
    `execute as @e[type=!minecraft:player] run data merge entity @s {Invulnerable:1b}`,
  ],
  tick: [
    // A new player, to the hub's spawn too: like a respawn, a first join can land on the roof.
    `execute as @a[tag=!${NS}.welcomed] run function ${TO_HUB}`,
    `tellraw @a[tag=!${NS}.welcomed] ${welcome}`,
    `tellraw @a[tag=!${NS}.welcomed] ${CREDITS_LINE}`,
    `tag @a[tag=!${NS}.welcomed] add ${NS}.welcomed`,
    `team join ${HUB} @a[team=!${HUB},${ZONE}]`,
    `execute as @a[${box(...PASSAGE.house.through)},gamemode=!spectator] run tp @s ${PASSAGE.hall.arrive}`,
    `execute as @a[${box(...PASSAGE.hall.through)},gamemode=!spectator] run tp @s ${PASSAGE.house.arrive}`,
    `scoreboard players enable @a ${BACK}`,
    `scoreboard players enable @a ${CREDITS}`,
    `scoreboard players add #glow ${TMP} 1`,
    `execute if score #glow ${TMP} matches ${GLOW_EVERY}.. run function ${NS}:hub/glow`,
    `execute as @a[scores={${BACK}=1..}] run function ${TO_HUB}`,
    `execute as @a[scores={${NS}.back=1..}] run function ${TO_HUB}`,
    `execute as @a[scores={${CREDITS}=1..}] run function ${NS}:hub/credits`,
    `execute as @a[scores={${NS}.left=1..}] run function ${TO_HUB}`,
    // Back from dying: Minecraft puts a world spawn under a roof on top of it, so the hub's spawn
    // is given by hand, once the player is alive again (a dead one is no entity).
    `execute as @e[type=minecraft:player,scores={${NS}.died=1..}] run function ${TO_HUB}`,
    `execute as @a[gamemode=!spectator,${FALLEN}] run function ${TO_HUB}`,
    // Never hungry outside the pit, and in it as hungry as anyone fighting: fed only once hunger
    // shows, so nothing is sent to a player who is full.
    `effect give @a[team=!${NS}.pit,scores={${NS}.food=..19}] minecraft:saturation 1 0 true`,
  ],
}
