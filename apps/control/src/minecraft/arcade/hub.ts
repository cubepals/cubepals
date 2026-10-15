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

import { CREDIT_LINES } from './credits.ts'
import {
  type Block,
  box,
  FALLEN,
  HUB_SPAWN,
  label,
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
export const PADS: ReadonlyArray<{ middle: Block; sends: string; name: string }> = [
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

/** The item every player keeps in their last slot: using it is going back to the hub. */
const BACK_ITEM = `minecraft:carrot_on_a_stick[custom_name={text:"Back to the hub",color:"${PAPER}",italic:false},item_model="minecraft:oak_door",custom_data={${NS}_back:1b}]`

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
  build: [
    ...PADS.map((pad) =>
      label(`${pad.middle[0] + 0.5} ${pad.middle[1] + 3.2} ${pad.middle[2] + 0.5}`, `${NS}.label`, pad.name),
    ),
    label('175.5 98.2 1444.5', `${NS}.label`, `{text:"Cubepals Arcade",color:"${PAPER}",bold:true}`, 4),
    label(
      '160.5 79.5 1430.5',
      `${NS}.label`,
      `["",{text:"Made of maps by NetherGames and the Overcast community.",color:"${PAPER}"},{text:"\\nType /trigger credits for who built each one.",color:"gray"}]`,
    ),
    label(
      `${STAIRS_TOP[0] + 0.5} ${STAIRS_TOP[1] + 3} ${STAIRS_TOP[2] + 1}`,
      `${NS}.label`,
      titled('The Arcade', 'Down the stairs'),
    ),
    label(
      `${PASSAGE.house.through[0][0] + 4} ${PASSAGE.house.through[0][1] + 1.9} ${PASSAGE.house.through[1][2]}`,
      `${NS}.label`,
      titled('The Arcade', 'Walk on through'),
    ),
    label(
      `${PASSAGE.hall.through[0][0] + 1.5} ${PASSAGE.hall.through[0][1] + 1.9} ${PASSAGE.hall.through[0][2] - 1.5}`,
      `${NS}.label`,
      titled('The house', 'Walk on through'),
    ),
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
    `execute as @a unless items entity @s hotbar.8 minecraft:carrot_on_a_stick[custom_data~{${NS}_back:1b}] run item replace entity @s hotbar.8 with ${BACK_ITEM}`,
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
