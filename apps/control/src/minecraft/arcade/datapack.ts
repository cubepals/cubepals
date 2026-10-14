// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What every part of the Arcade's datapack is written with: the shape a part takes, where the hub
 * is, and how a place in the world is named in a selector. Not any game's rules, which are each
 * game's own file.
 */

/** A block position: x, y and z. */
export type Block = readonly [number, number, number]

/**
 * One part of the datapack. Its functions go under `arcade:`, by the name given; `load` runs as
 * the world loads, `build` once its chunks are in, a moment later, and `tick` every tick.
 */
export interface Part {
  functions: Readonly<Record<string, readonly string[]>>
  load: readonly string[]
  build: readonly string[]
  tick: readonly string[]
}

/** The datapack's namespace: `arcade:parkour/finish` is one of its functions. */
export const NS = 'arcade'

/** Where everyone starts, comes back to and respawns: the middle of the hub, facing its boards. */
export const HUB_SPAWN = '0.5 101 0.5 0 0'

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

/** A `fill` of a box of blocks with one block. */
export const fill = (from: Block, to: Block, block: string): string =>
  `fill ${from.join(' ')} ${to.join(' ')} minecraft:${block}`

/**
 * Below y 90, a player has fallen off whatever they were on. A box, not a height alone: a selector
 * given only `y` and `dy` measures x and z from where it is run, a single block wide.
 */
export const FALLEN = box([-1000, -128, -1000], [1000, 89, 1000])

/**
 * A label floating over a place, as a text display: lit as by day, turned to whoever reads it.
 * Every one is tagged, so each build removes the last build's before making its own.
 */
export function label(at: string, tag: string, text: string): string {
  return `summon minecraft:text_display ${at} {Tags:["${NS}.display","${tag}"],billboard:"vertical",brightness:{block:15,sky:15},line_width:220,text:${text}}`
}
