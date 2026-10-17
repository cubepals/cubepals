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
import type { CarriedFile } from '../../domain/revision/carried.ts'
import { artFiles, MAPS_26_2, type MapArt } from '../map-art.ts'
import { AXES, buildMarquee, type Frame, type Marquee, marqueeExtent } from '../marquee.ts'
import { type Block, type Facing, type Label, NS, PAPER } from './datapack.ts'
import { ARCADE_MAPS } from './maps.ts'

/**
 * The art of each size of sign, by its side in blocks: the maps it shows, numbered from here, well
 * past the maps the world already holds (9000 to 9104, the lockup its signs once showed) and any a
 * player could make. Signs of one size show the same maps.
 */
const ART: Readonly<Record<number, MapArt>> = {
  4: { side: 4, firstId: 9200 },
  6: { side: 6, firstId: 9216 },
  5: { side: 5, firstId: 9252 },
}

const artOf = (side: number): MapArt => {
  const art = ART[side]
  if (art === undefined) throw new Error(`No art for a sign ${side} blocks square`)
  return art
}

/** The maps every size of sign shows, as files in the world's data, for 26.2, the Arcade's release. */
export const SIGN_MAP_FILES: readonly CarriedFile[] = Object.values(ART).flatMap((art) =>
  artFiles(art, MAPS_26_2),
)

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
  art: artOf(sign.side),
})

/** Where a sign stands and how large it is: all that says what it takes. */
export type SignPlace = Pick<BrandSign, 'at' | 'facing' | 'side' | 'backed'>

/** Everything a sign takes, from its least corner to its greatest, in blocks. */
export const signExtent = (sign: SignPlace): [Block, Block] =>
  marqueeExtent({ ...sign, backed: sign.backed ?? true })

/**
 * Taking a sign down: everything it took, air again. Only where a sign stood in the open, with
 * nothing of a map's own inside its box, as each the games once had has.
 */
export function clearSign(sign: SignPlace): string {
  const [from, to] = signExtent(sign)
  return `fill ${from.join(' ')} ${to.map((v) => v - 1).join(' ')} minecraft:air`
}

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
  // The base is level with the panel (`marquee.ts`), so its face is the panel's.
  const panelFace = toward > 0 ? sign.at[out] + 1 : sign.at[out]
  at[out] = panelFace + toward * OFF
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
