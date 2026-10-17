// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' signs on its own servers, built into the world: the look its servers have everywhere,
 * as in the server list, the mark alone in Ink on a square of Paper, with square corners, set in a
 * frame of the place's own blocks. The frame stands a block proud of the Paper, lights every other
 * block round its top and sides and a solid base under it, and the mark stands out from the Paper
 * a quarter of a block: any further, and its shapes' sides, as black as their faces, run them
 * together seen from below. Not where each sign is, which is each game's.
 *
 * The Paper is a text display's background, which the game draws in its exact colour; a block
 * or an item in its place would be shaded grey by the light. The mark is drawn as the pack's
 * pictures draw it (`brand-art.ts`), a fraction of a block to a cell, with the brand's clear space
 * round it (`brand/README.md`): block displays of black concrete for its depth, each faced in Ink
 * the same way as the Paper. The
 * same square turns to whoever looks over each of the Arcade's pads (`markBadge`).
 */
import { type Block, exactly, type Facing, INK, PAPER, YAW } from './arcade/datapack.ts'
import { markPixels } from './brand-art.ts'

/** The brand's clear space round the mark: a quarter of its height, on every side. */
const CLEAR = 0.25

/** How far the mark stands out from the Paper, in blocks. */
const RELIEF = 0.25

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
  /** The Paper square's side, in blocks; the frame goes round it. */
  side: number
  /** Cells of the mark to a block. */
  grain: number
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

/** One block of the frame round the square, at the square's plane and in front of it. */
function frameBlock(sign: Marquee, across: number, down: number): string[] {
  const { side, frame } = sign
  const edge = across === -1 || across === side
  const [corner, base] = [edge && (down === -1 || down === side), down === side]
  const [back, front] = corner
    ? [frame.corner, frame.corner]
    : !base && (across + down) % 2 === 0
      ? [frame.lamp, frame.bulb]
      : [frame.casing, frame.casing]
  return [setblock(place(sign, across, down, 0), back), setblock(place(sign, across, down, 1), front)]
}

/** The blocks: its casing behind, the square's blocks under the Paper, and the frame round it two blocks deep. */
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

/** A rectangle of the mark's cells: its top left, and how many across and down. */
interface Patch {
  column: number
  row: number
  columns: number
  rows: number
}

/** The mark's cells as rectangles: each row's runs, each carried down while the rows under it repeat it. */
function patches(cells: readonly (readonly boolean[])[]): Patch[] {
  let open = new Map<number, Patch>()
  const done: Patch[] = []
  cells.forEach((line, row) => {
    const next = new Map<number, Patch>()
    let run: Patch | undefined
    line.forEach((on, column) => {
      if (!on) run = undefined
      else if (run !== undefined) run.columns++
      else {
        run = { column, row, columns: 1, rows: 1 }
        next.set(column, run)
      }
    })
    for (const [column, patch] of next) {
      const above = open.get(column)
      if (above !== undefined && above.columns === patch.columns) {
        above.rows++
        next.set(column, above)
        open.delete(column)
      }
    }
    done.push(...open.values())
    open = next
  })
  return [...done, ...open.values()]
}

/** The mark as large as a square `cells` across holds with its clear space round it. */
function markIn(cells: number): boolean[][] {
  const most = Math.floor(cells / (1 + 2 * CLEAR))
  return markPixels(Math.floor((most - 1) / 2), 5)
}

/** Four places after the point. */
const exact = (value: number) => Number(value.toFixed(4))

/** A colour as a display's background takes it: opaque, one signed ARGB number. */
const argb = (hex: string) => 0xff000000 | Number.parseInt(hex.slice(1), 16)

const tagged = (tags: readonly string[]) => `Tags:[${tags.map((tag) => `"${tag}"`).join(',')}]`
const transformation = (scale: readonly number[], translation: readonly number[] = [0, 0, 0]) =>
  `transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[${translation.map((v) => `${exact(v)}f`).join(',')}],scale:[${scale.map((v) => `${exact(v)}f`).join(',')}]}`

/**
 * A square of colour as a text display draws it: its background behind one space. A space's
 * background is five of the game's text pixels across, from two left of where it stands to three
 * right, and ten up from it, forty to a block: so a square `width` by `height` blocks, its middle
 * bottom where it stands, is that scaled by 8 and 4 to a block, and moved a fifth of its width left.
 */
const square = (width: number, height: number, colour: string, translation: readonly number[]) =>
  `text:" ",background:${argb(colour)},default_background:false,see_through:false,shadow:false,brightness:{block:15,sky:15},${transformation(
    [8 * width, 4 * height, 1],
    [(translation[0] ?? 0) - width / 10, translation[1] ?? 0, translation[2] ?? 0],
  )}`

/** The Paper square in front of the square's blocks, and the mark on it in Ink, standing out from it. */
function badge(sign: Marquee, tags: readonly string[]): string[] {
  const cells = markIn(sign.side * sign.grain)
  const { along, right, out, toward } = AXES[sign.facing]
  const offset = (sign.side - cells.length / sign.grain) / 2
  // The square's left edge along the sign, its bottom, and its face.
  const edge = right > 0 ? sign.at[along] : sign.at[along] + 1
  const face = toward > 0 ? sign.at[out] + 1 : sign.at[out]
  const middle: [number, number, number] = [0, sign.at[1] + 1 - sign.side, 0]
  middle[along] = edge + (right * sign.side) / 2
  middle[out] = face + toward * 0.002
  const paper = `summon minecraft:text_display ${exactly(middle.map(exact))} {${tagged(tags)},billboard:"fixed",Rotation:[${YAW[sign.facing]}f,0f],${square(sign.side, sign.side, PAPER, [0, 0, 0])}}`
  const ink = patches(cells).flatMap((patch) => {
    const from: [number, number, number] = [0, 0, 0]
    const size: [number, number, number] = [0, 0, 0]
    const [a, b] = [offset + patch.column / sign.grain, offset + (patch.column + patch.columns) / sign.grain]
    from[along] = Math.min(edge + right * a, edge + right * b)
    size[along] = b - a
    from[1] = sign.at[1] + 1 - offset - (patch.row + patch.rows) / sign.grain
    size[1] = patch.rows / sign.grain
    from[out] = toward > 0 ? face : face - RELIEF
    size[out] = RELIEF
    // Its front in Ink itself, a hair proud of the block's face, which the game would draw greyer.
    const front: [number, number, number] = [...from]
    front[along] = from[along] + size[along] / 2
    front[out] = face + toward * (RELIEF + 0.002)
    return [
      `summon minecraft:block_display ${exactly(from.map(exact))} {${tagged(tags)},block_state:{Name:"minecraft:black_concrete"},brightness:{block:15,sky:15},${transformation(size)}}`,
      `summon minecraft:text_display ${exactly(front.map(exact))} {${tagged(tags)},billboard:"fixed",Rotation:[${YAW[sign.facing]}f,0f],${square(size[along], size[1], INK, [0, 0, 0])}}`,
    ]
  })
  return [paper, ...ink]
}

/**
 * Everything a sign takes, its blocks and what stands out in front of its Paper: the box from its
 * least corner to its greatest, in blocks, the frame round the square two deep and the casing behind.
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

/** Every command that builds a sign: its blocks, then its Paper and mark, whose displays carry `tags`. */
export const buildMarquee = (sign: Marquee, tags: readonly string[]): string[] => [
  ...blocks(sign),
  ...badge(sign, tags),
]

/**
 * The same square on its own, turning to whoever looks: `side` blocks across, its middle at `at`, a
 * text display of Paper and one of Ink for each rectangle of the mark, all standing where it does,
 * so they turn as one.
 */
export function markBadge(
  at: readonly [number, number, number],
  side: number,
  tags: readonly string[],
): string[] {
  const grain = 12
  const cells = markIn(side * grain)
  const offset = (side - cells.length / grain) / 2
  const bottom: [number, number, number] = [at[0], at[1] - side / 2, at[2]]
  const summon = (body: string) =>
    `summon minecraft:text_display ${exactly(bottom)} {${tagged(tags)},billboard:"vertical",${body}}`
  return [
    summon(square(side, side, PAPER, [0, 0, 0])),
    ...patches(cells).map((patch) => {
      const [width, height] = [patch.columns / grain, patch.rows / grain]
      const left = -side / 2 + offset + patch.column / grain
      const top = side - offset - patch.row / grain
      return summon(square(width, height, INK, [left + width / 2, top - height, 0.01]))
    }),
  ]
}
