// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's leaderboards: the top ten of each, kept in the world's own storage with each
 * player's name, so they hold through restarts, sleep and players who have left, and drawn on a
 * board floating before the hub's domes. Not what a score is or when it counts, which each game
 * decides; a game hands its board a score and the words to show for it.
 *
 * A board is a list in storage, best first, of `{uuid, name, score, shown}`: higher scores rank
 * higher, so a time where less is better is handed in negated. A player is on a board once, with
 * their best: a game submits only a new best, and submitting takes the player's old entry off.
 * The name comes from a player head the loot table fills with the player's profile, the one way a
 * datapack reads a player's name as text.
 */
import { type Block, label, NS, PAPER, type Part, YELLOW } from './datapack.ts'

/** The world storage that keeps each board, by its key. */
const BOARDS = `${NS}:boards`

/** Scratch storage: the entry being submitted (`new`), a board's list and the text being drawn. */
export const WORK = `${NS}:work`

/** The objective for scratch numbers, where `#20` and `#2` are kept for dividing ticks. */
export const TMP = `${NS}.tmp`

interface Board {
  key: string
  title: string
  at: Block
}

/**
 * The boards, west to east, one before each of the four domes along the hub's balcony, each
 * beside its game's pad: the parkour's west of the middle, the pit's by the middle, the falling
 * floor's two east of it.
 */
const BOARD_LIST: readonly Board[] = [
  { key: 'pk', title: 'Parkour: fastest', at: [123.5, 83.5, 1434.5] },
  { key: 'kills', title: 'The pit: kills', at: [151.5, 83.5, 1434.5] },
  { key: 'ff', title: 'Falling floor: longest', at: [199.5, 83.5, 1434.5] },
  { key: 'wins', title: 'Falling floor: wins', at: [227.5, 83.5, 1434.5] },
]

/** How much larger a board's text is than the game's, to be read from across the balcony. */
const BOARD_SCALE = 1.6

/**
 * Hands the player's entry in `WORK new` to a board, which keeps it if it is in the top ten. Run as
 * the player and at them.
 */
export const submit = (board: string): string => `function ${NS}:boards/submit {board:"${board}"}`

/** Writes `#ticks` in `TMP` into `WORK new.shown` as seconds to a tenth: `41.3s`. */
export const SECONDS = `function ${NS}:boards/seconds`

/**
 * A time written by `SECONDS`, from its path in `WORK`, as a chat message shows it. Read as text,
 * since the storage holds it as a string and would show its quotes; `41.3s` reads as itself.
 */
export const shown = (path: string): string => `{storage:"${WORK}",nbt:"${path}",interpret:true,color:"gold"}`

/** Writes `WORK new.score` into `WORK new.shown` as it is: `12`. */
export const AS_COUNT = `function ${NS}:boards/count with storage ${WORK} new`

/** Shows the player's score on a sidebar objective as `WORK new.shown`, not as its number. */
export const onSidebar = (objective: string): string[] => [
  `data modify storage ${WORK} new.objective set value "${objective}"`,
  `function ${NS}:boards/side with storage ${WORK} new`,
]

/** The loot table that fills a player head with the profile of the player it is run as. */
const HEAD_LOOT = {
  pools: [
    {
      rolls: 1,
      entries: [
        {
          type: 'minecraft:item',
          name: 'minecraft:player_head',
          functions: [{ function: 'minecraft:fill_player_head', entity: 'this' }],
        },
      ],
    },
  ],
}

export const BOARDS_PART: Part = {
  functions: {
    'boards/submit': [
      `function ${NS}:boards/name`,
      `data modify storage ${WORK} list set value []`,
      `$data modify storage ${WORK} list set from storage ${BOARDS} $(board)`,
      `function ${NS}:boards/forget with storage ${WORK} new`,
      `data modify storage ${WORK} out set value []`,
      `execute store result score #new ${TMP} run data get storage ${WORK} new.score`,
      `function ${NS}:boards/take`,
      `data modify storage ${WORK} out append from storage ${WORK} new`,
      `data modify storage ${WORK} out append from storage ${WORK} list[]`,
      `data remove storage ${WORK} out[10]`,
      `$data modify storage ${BOARDS} $(board) set from storage ${WORK} out`,
      `$function ${NS}:boards/render {board:"$(board)"}`,
    ],
    // The player's name and UUID, from a head filled with their profile. Run at the player, so
    // the head's holder is in a loaded chunk.
    'boards/name': [
      `summon minecraft:item_display ~ ~ ~ {Tags:["${NS}.namer"]}`,
      `loot replace entity @e[type=minecraft:item_display,tag=${NS}.namer,limit=1,sort=nearest] contents loot ${NS}:head`,
      `data modify storage ${WORK} new.name set from entity @e[type=minecraft:item_display,tag=${NS}.namer,limit=1,sort=nearest] item.components."minecraft:profile".name`,
      `data modify storage ${WORK} new.uuid set from entity @s UUID`,
      `kill @e[type=minecraft:item_display,tag=${NS}.namer]`,
    ],
    'boards/forget': [`$data remove storage ${WORK} list[{uuid:$(uuid)}]`],
    // Moves the entries that rank at or above the new one, in order, from `list` to `out`.
    'boards/take': [
      `execute unless data storage ${WORK} list[0] run return 0`,
      `execute store result score #at ${TMP} run data get storage ${WORK} list[0].score`,
      `execute if score #at ${TMP} < #new ${TMP} run return 0`,
      `data modify storage ${WORK} out append from storage ${WORK} list[0]`,
      `data remove storage ${WORK} list[0]`,
      `function ${NS}:boards/take`,
    ],
    'boards/render': [
      `$data modify storage ${WORK} text set from storage ${NS}:titles $(board)`,
      `data modify storage ${WORK} list set value []`,
      `$data modify storage ${WORK} list set from storage ${BOARDS} $(board)`,
      `execute unless data storage ${WORK} list[0] run data modify storage ${WORK} text append value {text:"\\nNobody yet. Be the first.",color:"gray"}`,
      `scoreboard players set #rank ${TMP} 0`,
      `function ${NS}:boards/line`,
      `$data modify entity @e[type=minecraft:text_display,tag=${NS}.board.$(board),limit=1] text set from storage ${WORK} text`,
    ],
    'boards/line': [
      `execute unless data storage ${WORK} list[0] run return 0`,
      `scoreboard players add #rank ${TMP} 1`,
      `execute store result storage ${WORK} list[0].rank int 1 run scoreboard players get #rank ${TMP}`,
      `function ${NS}:boards/append with storage ${WORK} list[0]`,
      `data remove storage ${WORK} list[0]`,
      `function ${NS}:boards/line`,
    ],
    'boards/append': [
      `$data modify storage ${WORK} text append value {text:"\\n$(rank). ",color:"gray"}`,
      `$data modify storage ${WORK} text append value {text:"$(name)",color:"white"}`,
      `$data modify storage ${WORK} text append value {text:"  $(shown)",color:"${PAPER}",bold:true}`,
    ],
    'boards/seconds': [
      `scoreboard players operation #sec ${TMP} = #ticks ${TMP}`,
      `scoreboard players operation #sec ${TMP} /= #20 ${TMP}`,
      `scoreboard players operation #tenth ${TMP} = #ticks ${TMP}`,
      `scoreboard players operation #tenth ${TMP} %= #20 ${TMP}`,
      `scoreboard players operation #tenth ${TMP} /= #2 ${TMP}`,
      `execute store result storage ${WORK} time.sec int 1 run scoreboard players get #sec ${TMP}`,
      `execute store result storage ${WORK} time.tenth int 1 run scoreboard players get #tenth ${TMP}`,
      `function ${NS}:boards/tenths with storage ${WORK} time`,
    ],
    'boards/tenths': [`$data modify storage ${WORK} new.shown set value "$(sec).$(tenth)s"`],
    'boards/count': [`$data modify storage ${WORK} new.shown set value "$(score)"`],
    'boards/side': [`$scoreboard players display numberformat @s $(objective) fixed "$(shown)"`],
  },
  load: [
    `scoreboard objectives add ${TMP} dummy`,
    `scoreboard players set #20 ${TMP} 20`,
    `scoreboard players set #2 ${TMP} 2`,
    ...BOARD_LIST.flatMap(({ key, title }) => [
      `execute unless data storage ${BOARDS} ${key} run data modify storage ${BOARDS} ${key} set value []`,
      `data modify storage ${NS}:titles ${key} set value ["",{text:"${title}",color:"${YELLOW}",bold:true}]`,
    ]),
  ],
  build: BOARD_LIST.flatMap(({ key, at }) => [
    label(at.join(' '), `${NS}.board.${key}`, '""', BOARD_SCALE),
    `function ${NS}:boards/render {board:"${key}"}`,
  ]),
  tick: [],
  data: { 'loot_table/head.json': HEAD_LOOT },
}
