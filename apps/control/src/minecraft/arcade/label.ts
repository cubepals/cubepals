// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a label is made: its words, and behind them a plate of Ink with the same room round the words
 * on every side (`plateOf`). The game's own background holds a label's words a pixel in from its
 * edges, and their shadow on the edge itself, so a letter's tail reads as cut off; a plate of its
 * own, behind words with no shadow, frames them evenly. Not where a label goes, which each part
 * says, nor the room it takes (`label-space.ts`).
 */
import { exactly, INK, type Label, LINE_WIDTH, NS, type Run, YAW } from './datapack.ts'
import { plateOf } from './label-space.ts'

/** Ink, opaque, as a display's background takes a colour: one signed ARGB number. */
const INK_ARGB = 0xff000000 | Number.parseInt(INK.slice(1), 16)

/** How far behind its words a plate stands, so the two never fight to be drawn. */
const BEHIND = 0.01

/** A label's words as a command writes text: a list of runs after an empty one. */
const textOf = (runs: readonly Run[]): string =>
  runs.length === 0
    ? '""'
    : `["",${runs.map((run) => `{text:${JSON.stringify(run.text)},color:"${run.color}"${run.bold ? ',bold:true' : ''}}`).join(',')}]`

const transformation = (scale: readonly number[], translation: readonly number[]) =>
  `transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[${translation.map((v) => `${Number(v.toFixed(5))}f`).join(',')}],scale:[${scale.map((v) => `${Number(v.toFixed(5))}f`).join(',')}]}`

/**
 * A plate drawn as a text display draws one space's background: five of the game's text pixels
 * across, from two left of where it stands to three right, and ten up from it, forty to a block. A
 * rectangle from `left` to `right` and `bottom` to `top`, in blocks, is that scaled and moved.
 */
function plateDisplay(shown: Label, turn: string, ns: string): string {
  const { left, right, bottom, top } = plateOf(shown)
  const [width, height] = [right - left, top - bottom]
  const middle = (left + right) / 2
  return `summon minecraft:text_display ${exactly(shown.at)} {Tags:["${ns}.display","${ns}.plate"],${turn},brightness:{block:15,sky:15},text:" ",background:${INK_ARGB},default_background:false,see_through:false,shadow:false,${transformation([8 * width, 4 * height, 1], [middle - width / 10, bottom, -BEHIND])}}`
}

/** The commands that make a label: its plate, then its words. */
export const label = (shown: Label): string[] => labelIn(shown, NS)

/** The same, for a label of another datapack than the Arcade's, its displays tagged under `ns`. */
export function labelIn(shown: Label, ns: string): string[] {
  const scale = shown.scale ?? 1
  const size = scale === 1 ? '' : `,${transformation([scale, scale, scale], [0, 0, 0])}`
  const turn =
    shown.facing === undefined
      ? 'billboard:"vertical"'
      : `billboard:"fixed",Rotation:[${YAW[shown.facing]}f,0f]`
  return [
    plateDisplay(shown, turn, ns),
    `summon minecraft:text_display ${exactly(shown.at)} {Tags:["${ns}.display","${shown.tag}"],${turn},brightness:{block:15,sky:15},background:0,default_background:false,see_through:false,shadow:false,line_width:${LINE_WIDTH},text:${textOf(shown.text)}${size}}`,
  ]
}
