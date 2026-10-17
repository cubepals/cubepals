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
 * the world loads, `build` once its chunks are in, a moment later, after its `labels` are made, and
 * `tick` every tick. `data` is any other file it needs under `data/arcade/`, as JSON:
 * `loot_table/head.json`.
 */
export interface Part {
  functions: Readonly<Record<string, readonly string[]>>
  data?: Readonly<Record<string, unknown>>
  load: readonly string[]
  /** Made as the build starts, before `build` runs. */
  labels?: readonly Label[]
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
 * Cubepals' colours: the brand's Paper as text and Ink as a display's background
 * (`brand/README.md`), and the site's indigo for headings (`--accent`, apps/web tokens), in
 * its dark theme's lighter step, since every label and chat line is on the dark.
 */
export const PAPER = '#F8F7F5'
export const INK = '#0D0D0D'
export const INDIGO = '#6A5CD3'

/** A way a thing faces: toward whoever reads it. */
export type Facing = 'north' | 'south' | 'east' | 'west'

/** The rotation that turns a display's front, or a sign's, to face that way. */
export const YAW: Record<Facing, number> = { south: 0, west: 90, north: 180, east: -90 }

/** A run of a label's words in one colour, bold or not. */
export interface Run {
  text: string
  color: string
  bold?: boolean
}

/**
 * A label floating over a place: words on Ink, lit as by day, never drawn through what stands in
 * front of them, the way a sign's are. One that faces a way stays flat, like a sign on a wall;
 * one that doesn't turns about its middle to whoever reads it, so nothing may stand within its
 * half width of it (`label-space.ts`).
 */
export interface Label {
  /** The bottom of the middle of its words. */
  at: readonly [number, number, number]
  /** Every label carries `${NS}.display`, so each build removes the last build's; this is its own. */
  tag: string
  text: readonly Run[]
  /** How many times the game's text it is. */
  scale?: number
  facing?: Facing
  /** For a label whose words change, a board: the most it ever shows, which its room is measured by. */
  widest?: readonly Run[]
}

/**
 * A place for an entity, as a command writes it: each number with its decimal point, since the game
 * moves a whole x or z to the middle of its block, half a block from where it was meant.
 */
export const exactly = (at: readonly number[]): string =>
  at.map((n) => (Number.isInteger(n) ? n.toFixed(1) : String(n))).join(' ')

/** How wide a label's line may be, in the game's text pixels, before its words wrap. */
export const LINE_WIDTH = 240

/** A label's heading, in the indigo, and its words below, in Paper. */
export const titled = (title: string, words: string): Run[] => [
  { text: title, color: INDIGO, bold: true },
  { text: `\n${words}`, color: PAPER },
]
