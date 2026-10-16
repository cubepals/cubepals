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

import { MARKER_ITEM, MARKERS, markerData, type ShownMarker, showMarker } from '../brand-pack.ts'
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
import { FLOOR_ARRIVAL } from './floor.ts'
import { PARKOUR_ARRIVAL } from './parkour.ts'
import { type BrandSign, hangSign } from './signs.ts'

const HUB = `${NS}.hub`

/** The large Cubepals sign, over the big ARCADE cabinet, facing the hall. */
export const HUB_SIGN: BrandSign = { art: 'large', at: [165, 110, 1359], facing: 'south' }

/** What a player types after `/trigger` to come back, or to read who made the maps. */
const BACK = 'hub'
const CREDITS = 'credits'

/**
 * Each game's pad on the balcony, by the block at its middle: Ink in a ring of Paper, built into
 * the world (`scripts/lib/arcade-brand.ts`), and what standing on it does.
 */
export const PADS: ReadonlyArray<{ middle: Block; sends: string; name: Label['text'] }> = [
  {
    middle: [126, 77, 1431],
    sends: `tp @s ${PARKOUR_ARRIVAL}`,
    name: titled('Parkour', 'Three courses against the clock'),
  },
  {
    middle: [175, 78, 1438],
    sends: `function ${NS}:pit/arrive`,
    name: titled('The pit', 'Everyone fights everyone'),
  },
  {
    middle: [224, 77, 1431],
    sends: `tp @s ${FLOOR_ARRIVAL}`,
    name: titled('Falling floor', 'Last one standing'),
  },
]

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

/** Standing on a pad; a moderator flying past in spectator mode isn't. */
const onPad = ([x, y, z]: Block) => `${box([x - 1, y + 1, z - 1], [x + 1, y + 2, z + 1])},gamemode=!spectator`

const welcome = `["",{text:"Welcome to the Cubepals Arcade. ",color:"${PAPER}",bold:true},"Step on a black pad to play a game, and see if you can get your name on the boards."]`

/**
 * The item every player keeps in their last slot: using it is going back to the hub. It is drawn
 * as an oak door, Cubepals' own with the pack (`brand-pack.ts`). A player carrying it as it was
 * before it was marked for the pack gets it again.
 */
const BACK_ITEM = `minecraft:carrot_on_a_stick[custom_name={text:"Back to the hub",color:"${PAPER}",italic:false},item_model="${MARKER_ITEM}",${markerData(MARKERS.backToHub)},custom_data={${NS}_back:1b}]`
const HAS_BACK_ITEM = `items entity @s hotbar.8 minecraft:carrot_on_a_stick[custom_data~{${NS}_back:1b},${markerData(MARKERS.backToHub)}]`

/**
 * Each doorway between the house and the hall ends at a wall: walking up to it is walking on
 * through (`PASSAGE`). Flat on that wall, just off it, are an open door and where it goes.
 */
const ENDS: ReadonlyArray<{ x: number; floor: number; z: number; facing: Facing; to: string }> = [
  { x: 168.03, floor: PASSAGE.house.through[0][1], z: 1460, facing: 'east', to: 'The Arcade' },
  { x: 138.5, floor: PASSAGE.hall.through[0][1], z: 1460.97, facing: 'north', to: 'The house' },
]

/** The markers over the ways in and out: the app icon's tile over each game's pad, above its name, and an open door at each passage's end. */
export const HUB_MARKERS: readonly ShownMarker[] = [
  ...PADS.map(({ middle: [x, y, z] }) => ({
    marker: MARKERS.portal,
    at: [x + 0.5, y + 4.6, z + 0.5] as const,
  })),
  ...ENDS.map(({ x, floor, z, facing }) => ({
    marker: MARKERS.wayOut,
    at: [x, floor + 1, z] as const,
    facing,
    scale: 0.8,
  })),
]

/** Every label in the hub: each game's name over its pad, the hub's name, the credits and the ways between the house and the hall. */
const HUB_LABELS: readonly Label[] = [
  ...PADS.map((pad) => ({
    at: [pad.middle[0] + 0.5, pad.middle[1] + 3.2, pad.middle[2] + 0.5] as const,
    tag: `${NS}.label`,
    text: pad.name,
  })),
  {
    at: [175.5, 98.2, 1444.5],
    tag: `${NS}.label`,
    text: [{ text: 'Cubepals Arcade', color: PAPER, bold: true }],
    scale: 4,
  },
  {
    at: [160.5, 79.5, 1430.5],
    tag: `${NS}.label`,
    text: [
      { text: 'Made of maps by NetherGames and the Overcast community.', color: PAPER },
      { text: '\nType /trigger credits for who built each one.', color: 'gray' },
    ],
  },
  // On the house's west wall, over the top of the stairs, facing a player as they start. The
  // house is two blocks across there, as the passages are, so it is the passages' size.
  {
    at: [STAIRS_TOP[0] - 2.97, STAIRS_TOP[1] + 2, STAIRS_TOP[2] + 1],
    tag: `${NS}.label`,
    text: titled('The Arcade', 'Down the stairs'),
    scale: 0.9,
    facing: 'east',
  },
  ...ENDS.map(({ x, floor, z, facing, to }) => ({
    at: [x, floor + 1.7, z] as const,
    tag: `${NS}.label`,
    text: titled(to, 'Walk on through'),
    // A little under the game's size, to fit the house's end, two blocks across.
    scale: 0.9,
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
    ...hangSign(HUB_SIGN),
    // Nothing in the hub can be hurt: whatever the maps brought along, and what the build made.
    `execute as @e[type=!minecraft:player] run data merge entity @s {Invulnerable:1b}`,
  ],
  tick: [
    // A new player, to the hub's spawn too: like a respawn, a first join can land on the roof.
    `execute as @a[tag=!${NS}.welcomed] run function ${TO_HUB}`,
    `tellraw @a[tag=!${NS}.welcomed] ${welcome}`,
    `tag @a[tag=!${NS}.welcomed] add ${NS}.welcomed`,
    `team join ${HUB} @a[team=!${HUB},${ZONE}]`,
    ...PADS.map((pad) => `execute as @a[${onPad(pad.middle)}] run ${pad.sends}`),
    `execute as @a[${box(...PASSAGE.house.through)},gamemode=!spectator] run tp @s ${PASSAGE.hall.arrive}`,
    `execute as @a[${box(...PASSAGE.hall.through)},gamemode=!spectator] run tp @s ${PASSAGE.house.arrive}`,
    `scoreboard players enable @a ${BACK}`,
    `scoreboard players enable @a ${CREDITS}`,
    `execute as @a unless ${HAS_BACK_ITEM} run item replace entity @s hotbar.8 with ${BACK_ITEM}`,
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
