// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Arcade's Cubepals signs: one on top of the hub's ARCADE cabinet, and one at each game's
 * start, each the mark in Ink on a square of Paper in a frame of the place's own blocks
 * (`../marquee.ts`): the hall's cabinet lights over the hub, jungle wood over the parkour, ice by
 * the falling floor and the market's spruce over the pit. Each part of the datapack builds its own
 * sign as it builds, over the plain Paper each sign once hung on, with a line on its frame's base
 * under a game's sign naming its map and who built it, flat on it so it never turns into it
 * (`creditLabel`). Not where the games are (`maps.ts`).
 */
import { AXES, buildMarquee, type Frame, type Marquee } from '../marquee.ts'
import { type Block, type Facing, type Label, NS, PAPER } from './datapack.ts'
import { ARCADE_MAPS } from './maps.ts'

/** Cells of the mark to a block. */
const GRAIN = 8

export interface BrandSign {
  /** The Paper square's block at its reader's top left. */
  at: Block
  /** The way the sign faces: toward whoever reads it. */
  facing: Facing
  /** The Paper square's side, in blocks. */
  side: number
  frame: Frame
  /** Whether a casing closes its back; not where another sign is back to back with it. */
  backed?: boolean
  /** The map it stands at, which a line on its base names, with who built it; none over the hub. */
  credit?: string
}

/** The frames of the games' signs, each in its map's own blocks. */
export const JUNGLE: Frame = {
  casing: 'jungle_planks',
  bulb: 'ochre_froglight',
  lamp: 'jungle_planks',
  corner: 'jungle_log',
}
export const ICE: Frame = {
  casing: 'packed_ice',
  bulb: 'light_blue_stained_glass',
  lamp: 'sea_lantern',
  corner: 'blue_ice',
}
export const MARKET: Frame = {
  casing: 'spruce_planks',
  bulb: 'shroomlight',
  lamp: 'spruce_planks',
  corner: 'stripped_spruce_log',
}

/** A sign as the marquee it is built as. */
const marquee = (sign: BrandSign): Marquee => ({
  at: sign.at,
  facing: sign.facing,
  frame: sign.frame,
  backed: sign.backed ?? true,
  side: sign.side,
  grain: GRAIN,
})

/** The commands that build a sign: its blocks and its lockup, the lockup carrying the build's tag. */
export const buildSign = (sign: BrandSign): string[] => buildMarquee(marquee(sign), [`${NS}.display`])

/** Names in a sentence: `Crazy_, ViceTechnicolour and Tywnis`. */
const inWords = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/** The line under a sign: the map it stands at and who built it, `Frozen Market, by _3Each`. */
function creditLine(key: string): string {
  const map = ARCADE_MAPS.find((candidate) => candidate.key === key)
  if (map === undefined) throw new Error(`No Arcade map ${key}`)
  return `${map.name}, by ${inWords(map.builders)}`
}

/** A twentieth of a block off the face it is on, as every label on a wall is. */
const OFF = 0.05

/** How large a credit line is: a little under the game's size, to fit a frame's base. */
const CREDIT_SCALE = 0.8

/**
 * Where a sign's credit line stands: on the middle of its frame's base, the row under the Paper,
 * a twentieth of a block off the frame's front, its one line in the middle of the row's height.
 */
function onBase(sign: BrandSign): Label['at'] {
  const { along, right, out, toward } = AXES[sign.facing]
  const at = [0, 0, 0]
  const left = right > 0 ? sign.at[along] : sign.at[along] + 1
  at[along] = left + (right * sign.side) / 2
  // A line is 12 of the game's 40 pixels to a block high, with its background.
  at[1] = sign.at[1] - sign.side + (1 - (12 / 40) * CREDIT_SCALE) / 2
  // The frame stands a block in front of the panel; its face is one further.
  const panelFace = toward > 0 ? sign.at[out] + 1 : sign.at[out]
  at[out] = panelFace + toward * (1 + OFF)
  return [at[0] ?? 0, at[1] ?? 0, at[2] ?? 0]
}

/** A sign's credit line, the map it stands at and who built it, or null for the hub's, which has none. */
export const creditLabel = (sign: BrandSign): Label | null =>
  sign.credit === undefined
    ? null
    : {
        at: onBase(sign),
        tag: `${NS}.label`,
        text: [{ text: creditLine(sign.credit), color: PAPER }],
        scale: CREDIT_SCALE,
        facing: sign.facing,
      }
