// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Leaderboards in a datapack: the top ten of each, kept in the world's own storage with each
 * player's name, so they hold through restarts, sleep and players who have left, and drawn as the
 * text of a display. Used by the Arcade's boards (`arcade/boards.ts`) and the Duels lobby's
 * parkour (`duels-waiting/parkour.ts`), each in its own datapack's namespace. Not what a score is
 * or when it counts, which each game decides, nor where a board hangs.
 *
 * A board is a list in storage, best first, of `{uuid, name, score, shown}`: higher scores rank
 * higher, so a time where less is better is handed in negated. A player is on a board once, with
 * their best: a game submits only a new best, and submitting takes the player's old entry off.
 * The name comes from a player head the loot table fills with the player's profile, the one way a
 * datapack reads a player's name as text.
 */
import { INDIGO, PAPER } from './arcade/datapack.ts'

/** A board: its key in storage, and its title over its lines. */
export interface BoardTitle {
  key: string
  title: string
}

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

/**
 * The boards of a datapack whose functions are under `ns:`. A board is drawn on the text display
 * tagged `<ns>.board.<key>`.
 */
export function leaderboards(ns: string, boards: readonly BoardTitle[]) {
  /** The world storage that keeps each board, by its key. */
  const BOARDS = `${ns}:boards`
  /** Scratch storage: the entry being submitted (`new`), a board's list and the text being drawn. */
  const WORK = `${ns}:work`
  /** The objective for scratch numbers, where `#20` and `#2` are kept for dividing ticks. */
  const TMP = `${ns}.tmp`
  return {
    WORK,
    TMP,
    /**
     * Hands the player's entry in `WORK new` to a board, which keeps it if it is in the top ten.
     * Run as the player and at them.
     */
    submit: (board: string): string => `function ${ns}:boards/submit {board:"${board}"}`,
    /** Writes `#ticks` in `TMP` into `WORK new.shown` as seconds to a tenth: `41.3s`. */
    SECONDS: `function ${ns}:boards/seconds`,
    /**
     * A time written by `SECONDS`, from its path in `WORK`, as a chat message shows it. Read as
     * text, since the storage holds it as a string and would show its quotes; `41.3s` reads as itself.
     */
    shown: (path: string): string => `{storage:"${WORK}",nbt:"${path}",interpret:true,color:"gold"}`,
    /** Writes `WORK new.score` into `WORK new.shown` as it is: `12`. */
    AS_COUNT: `function ${ns}:boards/count with storage ${WORK} new`,
    /** Shows the player's score on a sidebar objective as `WORK new.shown`, not as its number. */
    onSidebar: (objective: string): string[] => [
      `data modify storage ${WORK} new.objective set value "${objective}"`,
      `function ${ns}:boards/side with storage ${WORK} new`,
    ],
    /** The functions, under `boards/`, and what runs as the world loads and once it is built. */
    functions: {
      'boards/submit': [
        `function ${ns}:boards/name`,
        `data modify storage ${WORK} list set value []`,
        `$data modify storage ${WORK} list set from storage ${BOARDS} $(board)`,
        `function ${ns}:boards/forget with storage ${WORK} new`,
        `data modify storage ${WORK} out set value []`,
        `execute store result score #new ${TMP} run data get storage ${WORK} new.score`,
        `function ${ns}:boards/take`,
        `data modify storage ${WORK} out append from storage ${WORK} new`,
        `data modify storage ${WORK} out append from storage ${WORK} list[]`,
        `data remove storage ${WORK} out[10]`,
        `$data modify storage ${BOARDS} $(board) set from storage ${WORK} out`,
        `$function ${ns}:boards/render {board:"$(board)"}`,
      ],
      // The player's name and UUID, from a head filled with their profile. Run at the player, so
      // the head's holder is in a loaded chunk.
      'boards/name': [
        `summon minecraft:item_display ~ ~ ~ {Tags:["${ns}.namer"]}`,
        `loot replace entity @e[type=minecraft:item_display,tag=${ns}.namer,limit=1,sort=nearest] contents loot ${ns}:head`,
        `data modify storage ${WORK} new.name set from entity @e[type=minecraft:item_display,tag=${ns}.namer,limit=1,sort=nearest] item.components."minecraft:profile".name`,
        `data modify storage ${WORK} new.uuid set from entity @s UUID`,
        `kill @e[type=minecraft:item_display,tag=${ns}.namer]`,
      ],
      'boards/forget': [`$data remove storage ${WORK} list[{uuid:$(uuid)}]`],
      // Moves the entries that rank at or above the new one, in order, from `list` to `out`.
      'boards/take': [
        `execute unless data storage ${WORK} list[0] run return 0`,
        `execute store result score #at ${TMP} run data get storage ${WORK} list[0].score`,
        `execute if score #at ${TMP} < #new ${TMP} run return 0`,
        `data modify storage ${WORK} out append from storage ${WORK} list[0]`,
        `data remove storage ${WORK} list[0]`,
        `function ${ns}:boards/take`,
      ],
      'boards/render': [
        `$data modify storage ${WORK} text set from storage ${ns}:titles $(board)`,
        `data modify storage ${WORK} list set value []`,
        `$data modify storage ${WORK} list set from storage ${BOARDS} $(board)`,
        `scoreboard players set #rank ${TMP} 0`,
        `execute unless data storage ${WORK} list[0] run data modify storage ${WORK} text append value {text:"\\nNobody yet. Be the first.",color:"gray"}`,
        `execute unless data storage ${WORK} list[0] run scoreboard players set #rank ${TMP} 1`,
        `function ${ns}:boards/line`,
        `function ${ns}:boards/fill`,
        `$data modify entity @e[type=minecraft:text_display,tag=${ns}.board.$(board),limit=1] text set from storage ${WORK} text`,
      ],
      'boards/line': [
        `execute unless data storage ${WORK} list[0] run return 0`,
        `scoreboard players add #rank ${TMP} 1`,
        `execute store result storage ${WORK} list[0].rank int 1 run scoreboard players get #rank ${TMP}`,
        `function ${ns}:boards/append with storage ${WORK} list[0]`,
        `data remove storage ${WORK} list[0]`,
        `function ${ns}:boards/line`,
      ],
      // Empty lines after the last, to a full board's ten, so the words start at the top of its
      // plate, which is a full board's size: the game stands a display's lines up from its foot.
      'boards/fill': [
        `execute if score #rank ${TMP} matches 10.. run return 0`,
        `scoreboard players add #rank ${TMP} 1`,
        `data modify storage ${WORK} text append value "\\n "`,
        `function ${ns}:boards/fill`,
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
        `function ${ns}:boards/tenths with storage ${WORK} time`,
      ],
      'boards/tenths': [`$data modify storage ${WORK} new.shown set value "$(sec).$(tenth)s"`],
      'boards/count': [`$data modify storage ${WORK} new.shown set value "$(score)"`],
      'boards/side': [`$scoreboard players display numberformat @s $(objective) fixed "$(shown)"`],
    } as Record<string, readonly string[]>,
    load: [
      `scoreboard objectives add ${TMP} dummy`,
      `scoreboard players set #20 ${TMP} 20`,
      `scoreboard players set #2 ${TMP} 2`,
      ...boards.flatMap(({ key, title }) => [
        `execute unless data storage ${BOARDS} ${key} run data modify storage ${BOARDS} ${key} set value []`,
        `data modify storage ${ns}:titles ${key} set value ["",{text:"${title}",color:"${INDIGO}",bold:true}]`,
      ]),
    ],
    /** Draws each board, once its display is made. */
    build: boards.map(({ key }) => `function ${ns}:boards/render {board:"${key}"}`),
    /** The files beside the functions, under `data/<ns>/`. */
    data: { 'loot_table/head.json': HEAD_LOOT } as Record<string, unknown>,
  }
}
