// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's hub, where everyone starts: a floor in the sky with a coloured pad for each game,
 * named over it, that sends a player there, the boards along its south edge, and the welcome. It
 * is also the way back: from a game's white pad, by typing `/trigger hub`, after a fall, and for a
 * player who comes back after leaving. Not the games or what their boards hold, which are their own.
 *
 * It also holds the world's rules for an arcade, in a function of their own (`arcade:rules`): no
 * monsters, no night or rain, no fall damage, no chat about advancements, and everyone spawning on
 * the hub. Game rules are renamed between releases, so a release that knows them by other names
 * fails that function alone.
 */
import { type Block, box, FALLEN, fill, HUB_SPAWN, label, NS, type Part, TO_HUB } from './datapack.ts'
import { FLOOR_ARRIVAL } from './floor.ts'
import { PARKOUR_ARRIVAL } from './parkour.ts'
import { PIT_ARRIVAL } from './pit.ts'

const HUB = `${NS}.hub`

/** What a player types after `/trigger` to come back: the one word of the datapack players see. */
const BACK = 'hub'

/** The hub's floor. */
const FLOOR_FROM: Block = [-12, 100, -8]
const FLOOR_TO: Block = [12, 100, 8]

/** Each game's pad: its corners, its block, where it sends a player, and its name over it. */
const PADS: ReadonlyArray<{ from: Block; to: Block; block: string; sends: string; name: string }> = [
  {
    from: [-12, 100, -1],
    to: [-10, 100, 1],
    block: 'light_blue_concrete',
    sends: PARKOUR_ARRIVAL,
    name: '["",{text:"Parkour\\n",color:"aqua",bold:true},"Beat the clock"]',
  },
  {
    from: [10, 100, -1],
    to: [12, 100, 1],
    block: 'yellow_concrete',
    sends: FLOOR_ARRIVAL,
    name: '["",{text:"Falling floor\\n",color:"yellow",bold:true},"Last one standing"]',
  },
  {
    from: [-1, 100, -8],
    to: [1, 100, -6],
    block: 'red_concrete',
    sends: PIT_ARRIVAL,
    name: '["",{text:"The pit\\n",color:"red",bold:true},"Everyone fights everyone"]',
  },
]

const ZONE = box([-13, 95, -9], [13, 130, 10])

/** Over the middle of a pad, a little above head height. */
const over = ({ from, to }: { from: Block; to: Block }) =>
  `${(from[0] + to[0] + 1) / 2} 102.6 ${(from[2] + to[2] + 1) / 2}`

const welcome = '"Step on a coloured pad to play a game, and see if you can get your name on the boards."'

export const HUB_PART: Part = {
  functions: {
    'hub/back': [
      `scoreboard players reset @s ${BACK}`,
      `scoreboard players reset @s ${NS}.left`,
      `tp @s ${HUB_SPAWN}`,
    ],
    rules: [
      'gamerule advance_time false',
      'gamerule advance_weather false',
      'gamerule spawn_monsters false',
      'gamerule fall_damage false',
      'gamerule immediate_respawn true',
      'gamerule respawn_radius 0',
      'gamerule show_advancement_messages false',
      'time set noon',
      'weather clear',
      // The block of `HUB_SPAWN`, facing the same way.
      'setworldspawn 0 101 0 0 0',
    ],
  },
  load: [
    'forceload add -16 -16 15 15',
    `scoreboard objectives add ${BACK} trigger`,
    `scoreboard objectives add ${NS}.left minecraft.custom:minecraft.leave_game`,
    `scoreboard objectives add ${NS}.food food`,
    `team add ${HUB}`,
    `team modify ${HUB} friendlyFire false`,
    `team modify ${HUB} collisionRule never`,
  ],
  build: [
    // Room around the hub and its boards on a world that has ground there.
    fill([-13, 90, -9], [13, 116, 10], 'air'),
    fill(FLOOR_FROM, FLOOR_TO, 'polished_andesite'),
    fill(
      [FLOOR_FROM[0] + 1, 100, FLOOR_FROM[2] + 1],
      [FLOOR_TO[0] - 1, 100, FLOOR_TO[2] - 1],
      'smooth_stone',
    ),
    fill([-1, 100, -1], [1, 100, 1], 'chiseled_quartz_block'),
    ...PADS.flatMap((pad) => [fill(pad.from, pad.to, pad.block), label(over(pad), `${NS}.label`, pad.name)]),
  ],
  tick: [
    `tellraw @a[tag=!${NS}.welcomed] ${welcome}`,
    `tag @a[tag=!${NS}.welcomed] add ${NS}.welcomed`,
    `team join ${HUB} @a[team=!${HUB},${ZONE}]`,
    ...PADS.map((pad) => `tp @a[${box(pad.from, [pad.to[0], 102, pad.to[2]])}] ${pad.sends}`),
    `scoreboard players enable @a ${BACK}`,
    `execute as @a[scores={${BACK}=1..}] run function ${TO_HUB}`,
    `execute as @a[scores={${NS}.left=1..}] run function ${TO_HUB}`,
    `execute as @a[${FALLEN}] run function ${TO_HUB}`,
    // Never hungry outside the pit, and in it as hungry as anyone fighting: fed only once hunger
    // shows, so nothing is sent to a player who is full.
    `effect give @a[team=!${NS}.pit,scores={${NS}.food=..19}] minecraft:saturation 1 0 true`,
  ],
}
