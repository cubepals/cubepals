// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What every part of the Arcade's datapack is written with: the shape a part takes, where the hub
 * is, how a place in the world is named in a selector, and how a label looks. Not any game's
 * rules, which are each game's own file, or where the maps are (`maps.ts`).
 */

/** A block position: x, y and z. */
export type Block = readonly [number, number, number]

/**
 * One part of the datapack. Its functions go under `arcade:`, by the name given; `load` runs as
 * the world loads, `build` once its chunks are in, a moment later, and `tick` every tick. `data`
 * is any other file it needs under `data/arcade/`, as JSON: `loot_table/head.json`.
 */
export interface Part {
  functions: Readonly<Record<string, readonly string[]>>
  data?: Readonly<Record<string, unknown>>
  load: readonly string[]
  build: readonly string[]
  tick: readonly string[]
}

/** The datapack's namespace: `arcade:parkour/finish` is one of its functions. */
export const NS = 'arcade'

/**
 * Where everyone starts, comes back to and respawns: inside the house on the grass over the hub's
 * hall, on the rug, facing the steps down to it (`scripts/lib/arcade-house.ts`).
 */
export const HUB_SPAWN = '182.5 122 1458.5 90 0'

/** The function that sends a player back to the hub, from anywhere, leaving whatever they played. */
export const TO_HUB = `${NS}:hub/back`

/**
 * The players inside a box of blocks, both corners included, as a selector's arguments. A player
 * is in it when any part of them is.
 */
export function box(from: Block, to: Block): string {
  const [x, y, z] = from
  return `x=${x},y=${y},z=${z},dx=${to[0] - x},dy=${to[1] - y},dz=${to[2] - z}`
}

/**
 * Below y 40, a player has fallen off whatever they were on: every map stands higher. A box, not a
 * height alone: a selector given only `y` and `dy` measures x and z from where it is run, a single
 * block wide.
 */
export const FALLEN = box([-3000, -128, -3000], [3000, 39, 3000])

/**
 * Cubepals' colours: the brand's Paper as text and Ink (#0D0D0D) as a display's ARGB
 * (`brand/README.md`), and the site's indigo for headings (`--accent`, apps/web tokens), in
 * its dark theme's lighter step, since every label and chat line is on the dark.
 */
export const PAPER = '#F8F7F5'
export const INDIGO = '#6A5CD3'
const INK_ARGB = -15921907

/**
 * A label floating over a place, as a text display in Cubepals' colours: Paper on Ink, lit as by
 * day, turned to whoever reads it, `scale` times the game's text. Every one is tagged, so each
 * build removes the last build's before making its own.
 */
export function label(at: string, tag: string, text: string, scale = 1): string {
  const size =
    scale === 1
      ? ''
      : `,transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[${scale}f,${scale}f,${scale}f]}`
  return `summon minecraft:text_display ${at} {Tags:["${NS}.display","${tag}"],billboard:"vertical",brightness:{block:15,sky:15},background:${INK_ARGB},line_width:240,text:${text}${size}}`
}

/** A label's heading, in the indigo, and its words below, in Paper. */
export const titled = (title: string, words: string): string =>
  `["",{text:"${title}",color:"${INDIGO}",bold:true},{text:"\\n${words}",color:"${PAPER}"}]`
