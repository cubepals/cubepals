// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Cubepals signs: the horizontal lockup, the mark and the lowercase wordmark, Ink on Paper, as
 * map art in glow item frames on a Paper backing. A large one over the hub's ARCADE cabinet, and a
 * small one at each game's start. The maps are in the world (`scripts/lib/arcade-brand.ts` draws
 * them, and builds each backing); each part of the datapack hangs its own sign's frames as it
 * builds, with a line under a game's sign naming its map and who built it, flat on the sign's wall
 * so that it never turns into it (`creditLabel`). Every small sign shows
 * the same maps. Not where the games are (`maps.ts`).
 */
import { type Block, type Facing, type Label, NS, PAPER } from './datapack.ts'
import { ARCADE_MAPS } from './maps.ts'

/** The two sizes of sign, by the frames across and down, and the first of their maps. */
export const SIGN_ART = {
  large: { columns: 20, rows: 4, firstMap: 9000 },
  small: { columns: 5, rows: 1, firstMap: 9100 },
} as const

export interface BrandSign {
  art: keyof typeof SIGN_ART
  /** The frame at the sign's top left, as a player reading it sees it. */
  at: Block
  /** The way the sign faces: toward whoever reads it. */
  facing: Facing
  /** The map it stands at, which a line under it names, with who built it; none over the hub. */
  credit?: string
}

/** Each way a frame faces: its number in the game, the way its columns run, and where its backing is. */
const FACING: Record<Facing, { code: number; right: Block; back: Block }> = {
  south: { code: 3, right: [1, 0, 0], back: [0, 0, -1] },
  north: { code: 2, right: [-1, 0, 0], back: [0, 0, 1] },
  east: { code: 5, right: [0, 0, -1], back: [-1, 0, 0] },
  west: { code: 4, right: [0, 0, 1], back: [1, 0, 0] },
}

/** Every frame of a sign, left to right and top to bottom, with the map it shows. */
function signFrames(sign: BrandSign): Array<{ at: Block; map: number }> {
  const { columns, rows, firstMap } = SIGN_ART[sign.art]
  const { right } = FACING[sign.facing]
  const [x, y, z] = sign.at
  return Array.from({ length: rows * columns }, (_, i) => {
    const [col, row] = [i % columns, Math.floor(i / columns)]
    return { at: [x + right[0] * col, y - row, z + right[2] * col] as Block, map: firstMap + i }
  })
}

/** The blocks a sign hangs on, one behind each frame: its two opposite corners. */
export function signBacking(sign: BrandSign): [Block, Block] {
  const frames = signFrames(sign)
  const { back } = FACING[sign.facing]
  const behind = ([x, y, z]: Block): Block => [x + back[0], y + back[1], z + back[2]]
  return [behind(frames[0]?.at ?? sign.at), behind(frames.at(-1)?.at ?? sign.at)]
}

/** Names in a sentence: `Crazy_, ViceTechnicolour and Tywnis`. */
const inWords = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/** The line under a sign: the map it stands at and who built it, `Frozen Market, by _3Each`. */
function creditLine(key: string): string {
  const map = ARCADE_MAPS.find((candidate) => candidate.key === key)
  if (map === undefined) throw new Error(`No Arcade map ${key}`)
  return `${map.name}, by ${inWords(map.builders)}`
}

/**
 * Under the middle of a sign, just in front of its wall: where its credit line stands, flat, as the
 * sign hangs, its words up from there.
 */
function under(sign: BrandSign): Label['at'] {
  const frames = signFrames(sign)
  const [first, last] = [frames[0]?.at ?? sign.at, frames.at(-1)?.at ?? sign.at]
  const { back } = FACING[sign.facing]
  const middle = (a: number, b: number, toward: number) => (a + b) / 2 + 0.5 + toward * 0.45
  return [middle(first[0], last[0], back[0]), last[1] - 0.3, middle(first[2], last[2], back[2])]
}

/** A sign's credit line, the map it stands at and who built it, or null for the hub's, which has none. */
export const creditLabel = (sign: BrandSign): Label | null =>
  sign.credit === undefined
    ? null
    : {
        at: under(sign),
        tag: `${NS}.label`,
        text: [{ text: creditLine(sign.credit), color: PAPER }],
        facing: sign.facing,
      }

/** The commands that hang a sign: a fixed, unbreakable glow frame for each of its maps. */
export const hangSign = (sign: BrandSign): string[] =>
  signFrames(sign).map(
    ({ at: [x, y, z], map }) =>
      `summon minecraft:glow_item_frame ${x} ${y} ${z} {Tags:["${NS}.display"],Facing:${FACING[sign.facing].code}b,Fixed:1b,Invisible:1b,Invulnerable:1b,Item:{id:"minecraft:filled_map",count:1,components:{"minecraft:map_id":${map}}}}`,
  )
