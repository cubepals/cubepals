// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' signs on its own servers, built into the world: the look its servers have everywhere,
 * as in the server list, the mark alone in Ink on a square of Paper, with square corners, set in a
 * frame of the place's own blocks. The frame stands a block proud of the square round its top and
 * sides, lights every other block of them, and a base level with the square under it. Not where
 * each sign is, which is each game's.
 *
 * The square is map art (`map-art.ts`): a map to each of its blocks, in glow item frames that show
 * it at full light, a hundred and twenty-eight pixels to a block, drawn from the mark's own shapes,
 * so its circles are round from anywhere a player stands. Nothing of the mark is a block.
 */
import type { Block, Facing } from './arcade/datapack.ts'
import { type MapArt, mapId } from './map-art.ts'

/** A frame's look: its casing, its corners, and its lights: a bulb at the front, and behind it a lamp. */
export interface Frame {
  casing: string
  corner: string
  bulb: string
  lamp: string
}

/** The hall's cabinets' own: white casing, and their lime glow, a sea lantern behind yellow glass. */
export const CABINET: Frame = {
  casing: 'white_concrete',
  corner: 'white_concrete',
  bulb: 'yellow_stained_glass',
  lamp: 'sea_lantern',
}

export interface Marquee {
  /** The Paper square's block at its reader's top left. */
  at: Block
  /** The way it faces: toward whoever reads it. */
  facing: Facing
  /** The square's side, in blocks; the frame goes round it. */
  side: number
  /** The maps the square shows, as many as it has blocks. */
  art: MapArt
  frame: Frame
  /** Whether a casing closes its back; not where another sign is back to back with it. */
  backed: boolean
}

/** Each way a sign faces: the axis along it and its reader's right on it, and the axis out of it toward its reader. */
export const AXES: Record<Facing, { along: 0 | 2; right: 1 | -1; out: 0 | 2; toward: 1 | -1 }> = {
  south: { along: 0, right: 1, out: 2, toward: 1 },
  north: { along: 0, right: -1, out: 2, toward: -1 },
  east: { along: 2, right: -1, out: 0, toward: 1 },
  west: { along: 2, right: 1, out: 0, toward: -1 },
}

/** The block `across` to its reader's right of the square's top left, `down` under it and `out` in front of it. */
function place(sign: Pick<Marquee, 'at' | 'facing'>, across: number, down: number, out: number): Block {
  const axes = AXES[sign.facing]
  const at: [number, number, number] = [...sign.at]
  at[axes.along] += axes.right * across
  at[1] -= down
  at[axes.out] += axes.toward * out
  return at
}

const setblock = ([x, y, z]: Block, block: string) => `setblock ${x} ${y} ${z} minecraft:${block}`
const fill = ([x0, y0, z0]: Block, [x1, y1, z1]: Block, block: string) =>
  `fill ${x0} ${y0} ${z0} ${x1} ${y1} ${z1} minecraft:${block}`

/**
 * One block of the frame round the square, at the square's plane and, but under it, in front of it
 * too. Players read a sign from under it, and a lip under the square would hide its foot from them.
 */
function frameBlock(sign: Marquee, across: number, down: number): string[] {
  const { side, frame } = sign
  const edge = across === -1 || across === side
  const [corner, base] = [edge && (down === -1 || down === side), down === side]
  const [back, front] = corner
    ? [frame.corner, frame.corner]
    : !base && (across + down) % 2 === 0
      ? [frame.lamp, frame.bulb]
      : [frame.casing, frame.casing]
  const inPlane = setblock(place(sign, across, down, 0), back)
  return base ? [inPlane] : [inPlane, setblock(place(sign, across, down, 1), front)]
}

/** The blocks: its casing behind, the square's blocks its maps hang on, and the frame round it two blocks deep. */
function blocks(sign: Marquee): string[] {
  const { side, frame } = sign
  const ring: string[] = []
  for (let across = -1; across <= side; across++)
    for (const down of [-1, side]) ring.push(...frameBlock(sign, across, down))
  for (let down = 0; down < side; down++)
    for (const across of [-1, side]) ring.push(...frameBlock(sign, across, down))
  return [
    ...(sign.backed ? [fill(place(sign, -1, -1, -1), place(sign, side, side, -1), frame.casing)] : []),
    fill(place(sign, 0, 0, 0), place(sign, side - 1, side - 1, 0), 'smooth_quartz'),
    ...ring,
  ]
}

/**
 * Taking down the row a sign once had in front of its base, a block proud of it as the rest of its
 * frame is: for where a sign stood built that way, and only where nothing else is in that row.
 */
export const clearOldBase = (sign: Marquee): string =>
  fill(place(sign, -1, sign.side, 1), place(sign, sign.side, sign.side, 1), 'air')

/** A block the sign's build always sets, and what to: the base under the square's first column, of its casing. */
export const footOf = (sign: Marquee): { at: Block; block: string } => ({
  at: place(sign, 0, sign.side, 0),
  block: sign.frame.casing,
})

const tagged = (tags: readonly string[]) => `Tags:[${tags.map((tag) => `"${tag}"`).join(',')}]`

/** The way an item frame faces, as the game numbers it: down, up, north, south, west, east. */
const FRAME_FACING: Record<Facing, number> = { north: 2, south: 3, west: 4, east: 5 }

/**
 * The square's maps, one to each block of it, each in a glow item frame hung on the block, in front
 * of it: fixed, so nothing turns or takes it, and invisible, so the maps meet edge to edge. Its
 * place and block are written out too: the game reads a frame's block before it moves it to where
 * it is summoned, and without them logs each frame as at an invalid place.
 */
function maps(sign: Marquee, tags: readonly string[]): string[] {
  if (sign.art.side !== sign.side) throw new Error('A sign shows a map to each block of its square')
  const frames: string[] = []
  for (let down = 0; down < sign.side; down++)
    for (let across = 0; across < sign.side; across++) {
      const [x, y, z] = place(sign, across, down, 1)
      frames.push(
        `summon minecraft:glow_item_frame ${x} ${y} ${z} {${tagged(tags)},Pos:[${x + 0.5}d,${y + 0.5}d,${z + 0.5}d],block_pos:[I;${x},${y},${z}],Facing:${FRAME_FACING[sign.facing]}b,Fixed:1b,Invisible:1b,Invulnerable:1b,Item:{id:"minecraft:filled_map",count:1,components:{"minecraft:map_id":${mapId(sign.art, across, down)}}}}`,
      )
    }
  return frames
}

/**
 * Everything a sign takes, its blocks and the frames its maps hang in: the box from its least
 * corner to its greatest, in blocks, the frame round the square two deep and the casing behind.
 */
export function marqueeExtent(sign: Pick<Marquee, 'at' | 'facing' | 'side' | 'backed'>): [Block, Block] {
  const corners = [place(sign, -1, -1, sign.backed ? -1 : 0), place(sign, sign.side, sign.side, 1)]
  const least = (i: number) => Math.min(...corners.map((corner) => corner[i] ?? 0))
  const most = (i: number) => Math.max(...corners.map((corner) => corner[i] ?? 0)) + 1
  return [
    [least(0), least(1), least(2)],
    [most(0), most(1), most(2)],
  ]
}

/** Every command that builds a sign: its blocks, then its maps, whose frames carry `tags`. */
export const buildMarquee = (sign: Marquee, tags: readonly string[]): string[] => [
  ...blocks(sign),
  ...maps(sign, tags),
]
