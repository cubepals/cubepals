// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's hub: NetherGames' ArcadeLobby, a hall of arcade cabinets whose balcony is where
 * everyone starts, with a black pad for each game that sends a player there, its name over it, the
 * boards in front of the balcony's domes, the welcome and the credits. It is also the way back:
 * the "Back to the hub" item every player carries, `/trigger hub`, a fall, dying, and coming back
 * after leaving. Not the games or what their boards hold, which are their own.
 *
 * It also holds the world's rules for an arcade, in a function of their own (`arcade:rules`): no
 * monsters, no night or rain, no fall damage, no chat about advancements, and everyone spawning on
 * the balcony. Game rules are renamed between releases, so a release that knows them by other
 * names fails that function alone.
 */
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
import { ARCADE_MAPS, type ArcadeMap, LICENCE_NAMES } from './maps.ts'
import { PARKOUR_ARRIVAL } from './parkour.ts'

const HUB = `${NS}.hub`

/**
 * The Cubepals lockup over the big ARCADE cabinet, as map art in glow item frames: its maps are in
 * the world (`scripts/lib/arcade-brand.ts` draws them), numbered from `firstMap`, left to right and
 * top to bottom as a player in the hall sees them, the frames' top left at `at`, facing south.
 */
export const WORDMARK_FRAMES = { columns: 10, rows: 2, firstMap: 9000, at: [171, 110, 1359] as Block }

/** What a player types after `/trigger` to come back, or to read who made the maps. */
const BACK = 'hub'
const CREDITS = 'credits'

/**
 * Each game's pad on the balcony, by the block at its middle: Ink in a ring of Paper, built into
 * the world (`scripts/lib/arcade-brand.ts`), and what standing on it does.
 */
export const PADS: ReadonlyArray<{ middle: Block; sends: string; name: string }> = [
  {
    middle: [138, 77, 1436],
    sends: `tp @s ${PARKOUR_ARRIVAL}`,
    name: titled('Parkour', 'Three courses against the clock'),
  },
  {
    middle: [175, 78, 1438],
    sends: `function ${NS}:pit/arrive`,
    name: titled('The pit', 'Everyone fights everyone'),
  },
  {
    middle: [214, 77, 1436],
    sends: `tp @s ${FLOOR_ARRIVAL}`,
    name: titled('Falling floor', 'Last one standing'),
  },
]

const ZONE = box([100, 40, 1340], [256, 125, 1460])

/** Standing on a pad; a moderator flying past in spectator mode isn't. */
const onPad = ([x, y, z]: Block) => `${box([x - 1, y + 1, z - 1], [x + 1, y + 2, z + 1])},gamemode=!spectator`

const welcome = `["",{text:"Welcome to the Cubepals Arcade. ",color:"${PAPER}",bold:true},"Step on a black pad to play a game, and see if you can get your name on the boards."]`

/** The item every player keeps in their last slot: using it is going back to the hub. */
const BACK_ITEM = `minecraft:carrot_on_a_stick[custom_name={text:"Back to the hub",color:"${PAPER}",italic:false},item_model="minecraft:oak_door",custom_data={${NS}_back:1b}]`

/** Who built a map, and who published it where that is someone else. */
const byWhom = (map: ArcadeMap) =>
  map.builders.join(', ') + (map.builders.join() === map.publisher ? '' : `, from ${map.publisher}`)

/** Who made each map, and under which licence, as the credits say it. */
const credits = [
  `{text:"The Cubepals Arcade is made of these maps, each under its own licence:",color:"${PAPER}",bold:true}`,
  ...ARCADE_MAPS.map(
    (map) =>
      `["",{text:"${map.title}",bold:true},{text:" (${map.role}) by ${byWhom(map)}, under the ${LICENCE_NAMES[map.licence]} licence (${map.licence})",color:"gray"}]`,
  ),
  '{text:"Cubepals changed them to fit together. Its changes to the CC BY-SA maps are CC BY-SA 4.0 too. Each licence is on Creative Commons’ website.",color:"gray"}',
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
    'hub/credits': [`scoreboard players reset @s ${CREDITS}`, ...credits.map((line) => `tellraw @s ${line}`)],
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
      'setworldspawn 175 78 1431 180 0',
    ],
  },
  load: [
    'forceload add 100 1340 256 1460',
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
    ...Array.from({ length: WORDMARK_FRAMES.rows * WORDMARK_FRAMES.columns }, (_, i) => {
      const [x, y, z] = WORDMARK_FRAMES.at
      const [col, row] = [i % WORDMARK_FRAMES.columns, Math.floor(i / WORDMARK_FRAMES.columns)]
      return `summon minecraft:glow_item_frame ${x + col} ${y - row} ${z} {Tags:["${NS}.display"],Facing:3b,Fixed:1b,Invisible:1b,Invulnerable:1b,Item:{id:"minecraft:filled_map",count:1,components:{"minecraft:map_id":${WORDMARK_FRAMES.firstMap + i}}}}`
    }),
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
