// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The room a label takes in the world, as the game draws a text display: its words in the game's
 * own font (`@blockly/contracts/minecraft-font`), wrapped at its line width, forty pixels to a block, standing up from where it is. A
 * label facing a way is flat; one turning to its reader sweeps a round space about its middle, as
 * wide as it is. What stands in that room shows through a label's words, or the words through it,
 * so a label must have it clear (`arcade.test.ts` checks every one against the world's blocks),
 * and so must a marker (`brand-pack.ts`). Not how a label looks (`datapack.ts`).
 */
import { glyphAdvance } from '@blockly/contracts/minecraft-font'
import type { ShownMarker } from '../brand-pack.ts'
import { type Block, type Facing, type Label, LINE_WIDTH, type Run } from './datapack.ts'

/** Text pixels to a block, and the height of a line of them, as a text display draws them. */
const PER_BLOCK = 40
const LINE_HEIGHT = 10

/** Each line a label's words take, as its width in text pixels: split where they say, and wrapped at its line width. */
export function lineWidths(runs: readonly Run[]): number[] {
  const lines: number[] = [0]
  let word = 0
  const endWord = () => {
    const at = lines.length - 1
    const current = lines[at] ?? 0
    if (current > 0 && current + word > LINE_WIDTH) lines.push(word)
    else lines[at] = current + word
    word = 0
  }
  for (const run of runs)
    for (const character of run.text) {
      if (character === '\n') {
        endWord()
        lines.push(0)
      } else {
        word += glyphAdvance(character, run.bold === true)
        if (character === ' ') endWord()
      }
    }
  endWord()
  return lines
}

/** The room a thing shown takes: from the bottom of its middle, as wide and tall as it is, and as deep, if it is flat. */
export interface Room {
  at: readonly [number, number, number]
  width: number
  height: number
  /** Flat, facing that way, and this thick; without, it turns about its middle to whoever looks. */
  flat?: { facing: Facing; depth: number }
}

/** How thick a flat label is: the game draws it a hair proud of where it stands. */
const TEXT_DEPTH = 0.02

/** The plate's room round a label's words, in the game's text pixels, the same on every side. */
export const PLATE_PAD = 2

/**
 * A label's plate, in blocks from where it stands, to its reader's right and up: its words' ink and
 * the same room round it on every side. The game draws a label's lines ten text pixels apart up from
 * where it stands, the bottom row of the last line one pixel over it, the top of the first at its
 * lines' height less one; across, the game moves its words a pixel right of centre, so their first
 * pixel is one in from half their width, and the last pixel of that width is the gap after the
 * last letter (as a client draws them, `docs/minecraft/readable-text.md`).
 */
export function plateOf(label: Pick<Label, 'text' | 'scale' | 'widest'>): {
  left: number
  right: number
  bottom: number
  top: number
} {
  const lines = lineWidths(label.widest ?? label.text)
  const scale = (label.scale ?? 1) / PER_BLOCK
  const widest = Math.max(...lines)
  return {
    left: (1 - widest / 2 - PLATE_PAD) * scale,
    right: (widest / 2 + PLATE_PAD) * scale,
    bottom: (1 - PLATE_PAD) * scale,
    top: (lines.length * LINE_HEIGHT - 1 + PLATE_PAD) * scale,
  }
}

/** The room a label's words take: its plate, and a turning one's sweep round its middle. */
export function roomOf(label: Label): Room {
  const { left, right, bottom, top } = plateOf(label)
  const [x, y, z] = label.at
  return {
    at: [x, y + bottom, z],
    width: 2 * Math.max(-left, right),
    height: top - bottom,
    ...(label.facing === undefined ? {} : { flat: { facing: label.facing, depth: TEXT_DEPTH } }),
  }
}

/** The room a marker takes, or a badge: a square as wide as it is, round its middle, as thick as an item drawn flat. */
export function markerRoom(marker: Pick<ShownMarker, 'at' | 'scale' | 'facing'>): Room {
  const side = marker.scale ?? 1
  const [x, y, z] = marker.at
  return {
    at: [x, y - side / 2, z],
    width: side,
    height: side,
    ...(marker.facing === undefined ? {} : { flat: { facing: marker.facing, depth: side / 16 } }),
  }
}

/** Whether a block, the whole cube from its corner, is in a room. */
export function inRoom(room: Room, [bx, by, bz]: Block): boolean {
  const [x, y, z] = room.at
  if (by >= y + room.height || by + 1 <= y) return false
  const half = room.width / 2
  if (room.flat === undefined) {
    const dx = Math.max(bx - x, 0, x - (bx + 1))
    const dz = Math.max(bz - z, 0, z - (bz + 1))
    return dx * dx + dz * dz < half * half
  }
  const across = room.flat.facing === 'north' || room.flat.facing === 'south'
  const thin = room.flat.depth / 2
  const [spanX, spanZ] = across ? [half, thin] : [thin, half]
  return bx < x + spanX && bx + 1 > x - spanX && bz < z + spanZ && bz + 1 > z - spanZ
}

/** A step out of a flat room's front, toward whoever reads it. */
const OUT: Record<Facing, readonly [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
}

/**
 * The wall a flat room stands on: the layer of blocks behind it, the layer it stands in, and how far
 * in front of the wall it is. A room is on a wall when it is within a tenth of a block of it; one
 * further out, a board before its dome, stands free. `across` is the axis it runs along, x or z,
 * and `mid` its middle on it.
 */
export function wallOf(room: Room): {
  across: 'x' | 'z'
  mid: number
  front: number
  wall: number
  gap: number
} | null {
  if (room.flat === undefined) return null
  const [ox, oz] = OUT[room.flat.facing]
  const [x, , z] = room.at
  const [plane, out] = ox === 0 ? [z, oz] : [x, ox]
  const front = out > 0 ? Math.floor(plane) : Math.ceil(plane) - 1
  const gap = out > 0 ? plane - front : front + 1 - plane
  if (gap > 0.1) return null
  return { across: ox === 0 ? 'x' : 'z', mid: ox === 0 ? x : z, front, wall: front - out, gap }
}

/** The box of blocks that holds a room: what reading the world for it must cover. */
export function roomBox(room: Room): [Block, Block] {
  const [x, y, z] = room.at
  const half = room.width / 2
  return [
    [Math.floor(x - half), Math.floor(y), Math.floor(z - half)],
    [Math.floor(x + half), Math.floor(y + room.height), Math.floor(z + half)],
  ]
}
