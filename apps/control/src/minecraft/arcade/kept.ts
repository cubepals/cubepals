// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What every Arcade player keeps in their hotbar, each in its own slot: the "Back to the hub" item
 * in the last, and the book that lists the games in the second. A player has exactly one of each,
 * there. The game lets an item be moved or dropped and no datapack can stop it, so one that isn't
 * in its slot is put back at once: every other copy the player has (inventory, offhand, the cursor
 * and the crafting grid) is cleared, and one goes in its slot; a dropped copy is removed from the
 * ground. Not what using one does: the back item counts as `arcade.back` (`hub.ts`), the book's
 * links are the `play` trigger (`ways-in.ts`).
 */
import { MARKER_ITEM, MARKERS, markerData } from '../brand-pack.ts'
import { INDIGO, NS, PAPER, type Part } from './datapack.ts'
import { GAMES, PLAY } from './ways-in.ts'

interface Kept {
  /** Its function's name, under `arcade:kept/`. */
  key: string
  slot: string
  /** The slot's number in the player's `Inventory`. */
  number: number
  /** The item, as a command gives it. */
  item: string
  /** The item as it is now, as an item predicate: one in its slot that isn't this is put back. */
  is: string
  /** Any copy of it, as it is now or was once, as an item predicate. */
  copy: string
}

/**
 * The item that takes a player back to the hub. It is drawn as an oak door, Cubepals' own with the
 * pack (`brand-pack.ts`). One carried as it was before it was marked for the pack is put back.
 */
const BACK: Kept = {
  key: 'back',
  slot: 'hotbar.8',
  number: 8,
  item: `minecraft:carrot_on_a_stick[custom_name={text:"Back to the hub",color:"${PAPER}",italic:false},item_model="${MARKER_ITEM}",${markerData(MARKERS.backToHub)},custom_data={${NS}_back:1b}]`,
  is: `minecraft:carrot_on_a_stick[custom_data~{${NS}_back:1b},${markerData(MARKERS.backToHub)}]`,
  copy: `minecraft:carrot_on_a_stick[custom_data~{${NS}_back:1b}]`,
}

/** A game's lines on the book's page: its name and what it is, both a link to `/trigger play set <n>`. */
const gameLines = (name: string, line: string, n: number): string => {
  const link = `click_event:{action:"run_command",command:"/trigger ${PLAY} set ${n}"},hover_event:{action:"show_text",value:"Go to ${name.toLowerCase()}"}`
  return `{text:${JSON.stringify(name)},color:"${INDIGO}",bold:true,${link}},{text:${JSON.stringify(`\n${line}\n\n`)},color:"dark_gray",${link}}`
}

/** The book's one page: its heading, then each game. */
const PAGE = `["",{text:"Pick a game\\n\\n",bold:true},${GAMES.map((game, i) => gameLines(game.name, game.line, i + 1)).join(',')}]`

/**
 * The book's contents, already resolved: the game resolves a book as it is first read, and one it
 * had changed would no longer be the book a player should have.
 */
const BOOK = `written_book_content={title:"Pick a game",author:"Cubepals",resolved:true,pages:[${PAGE}]}`

/** The book that lists the games, each a link that sends a player there. */
const PICKER: Kept = {
  key: 'picker',
  slot: 'hotbar.1',
  number: 1,
  item: `minecraft:written_book[${BOOK},custom_data={${NS}_picker:1b}]`,
  is: `minecraft:written_book[${BOOK},custom_data~{${NS}_picker:1b}]`,
  copy: `minecraft:written_book[custom_data~{${NS}_picker:1b}]`,
}

export const KEPT: readonly Kept[] = [BACK, PICKER]

const DISPLACED = `${NS}.displaced`

/**
 * Putting a kept item back in its slot, run as the player: every copy cleared, then whatever else is
 * in the slot dropped at their feet for them to pick up again, so nothing of theirs is lost, then
 * the item.
 */
const putBack = (kept: Kept): string[] => [
  `clear @s ${kept.copy}`,
  `execute if items entity @s ${kept.slot} * at @s run summon minecraft:item ~ ~ ~ {Tags:["${DISPLACED}"],Item:{id:"minecraft:stone",count:1},PickupDelay:0}`,
  `execute if items entity @s ${kept.slot} * at @s run data modify entity @e[type=minecraft:item,tag=${DISPLACED},limit=1,sort=nearest] Item set from entity @s Inventory[{Slot:${kept.number}b}]`,
  `tag @e[type=minecraft:item,tag=${DISPLACED}] remove ${DISPLACED}`,
  `item replace entity @s ${kept.slot} with ${kept.item}`,
]

/** Gives a player everything kept, each in its slot: after a game has cleared their inventory, before it fills it. */
export const KEEP = `function ${NS}:kept`

export const KEPT_PART: Part = {
  functions: {
    kept: KEPT.map((kept) => `function ${NS}:kept/${kept.key}`),
    ...Object.fromEntries(KEPT.map((kept) => [`kept/${kept.key}`, putBack(kept)])),
  },
  load: [],
  build: [],
  tick: KEPT.flatMap((kept) => [
    `execute as @e[type=minecraft:item] if items entity @s contents ${kept.copy} run kill @s`,
    `execute as @a unless items entity @s ${kept.slot} ${kept.is} run function ${NS}:kept/${kept.key}`,
  ]),
}
