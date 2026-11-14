// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The parts under the island's world, drawn as a stack: a plate for each part Cubepals runs, the
 * size of the island's cube, one under the other along its height, seen through the island's own
 * camera, so the island's print sits on top as the world. For one print of the island, this works
 * out where everything falls on the picture, in CSS pixels: the plates' faces, their names, the
 * rails between their corners, the players at the door, and how far the parts over a plate rise for
 * its whole top to show. Not what a plate's top shows, which is tops.ts, nor how the parts move,
 * which is motion.ts.
 */
import { project, type Vec3 } from '../engine/camera'
import { SIZE } from '../engine/chunk'
import { CUT, GRASS, openingCamera } from '../island/scene'

/** The parts, top to bottom: the world is the island's print, the others are plates under it. */
export const PARTS = ['world', 'game', 'power', 'door', 'backups'] as const
export type Part = (typeof PARTS)[number]
export type Plate = Exclude<Part, 'world'>

/** One print of the island: how many dots across and down, and how many CSS pixels a dot is. */
export interface Print {
  across: number
  down: number
  unit: number
}

/** A point on the picture, in CSS pixels from the drawing's top left. */
export type Spot = readonly [number, number]

/** Blocks from a part down to the plate under it, a plate's thickness, and how deep the backups' sheets go. */
const GAP = 6.6
const THICK = 0.6
const SHEETS = 2.9

/** How far a plate is pulled out when it is read, in blocks along its right-hand side: across the picture. */
const PULLED = 2.2

/**
 * Rises, in gaps between two parts at rest: the read plate off the one under it; how clear of its
 * far corner the part over it rises; how much closer the parts further up come to each other while
 * one is open; the world when it is read; and the gap left between the parts, packed, at the start.
 */
const RISE = 0.2
const CLEAR = 0.2
const CLOSER = 0.42
const WORLD = 0.3
const PACKED = 0.2

/** The type the names and labels are set in, in CSS pixels, and how far a name stands off its corner. */
export const TYPE = { name: 11, note: 11.5, label: 11, spacing: 0.6, off: 18, line: 17 } as const

/** How wide a line of mono type is: Plex Mono's glyphs are each 0.6 of its size, and the spacing between. */
export const widthOf = (text: string, size: number, spacing = 0) => text.length * (0.6 * size + spacing)

/** A player at the door: where they stand on its floor, which way their card lies, what it says, and their way in. */
interface Player {
  name: 'java' | 'bedrock'
  at: readonly [number, number]
  long: 'x' | 'z'
  label: readonly [string, string]
  /** Their way to the door's left-hand corner, along its floor: x and z, in blocks. */
  trace: readonly (readonly [number, number])[]
}

/** A Java player along the door's near left side, a Bedrock one along its other: their ways meet at its corner. */
const JAVA: Player = {
  name: 'java',
  at: [-8.6, SIZE],
  long: 'x',
  label: ['JAVA', 'PC'],
  trace: [
    [-6.2, SIZE],
    [0, SIZE],
  ],
}
const BEDROCK: Player = {
  name: 'bedrock',
  at: [0, SIZE + 8.6],
  long: 'z',
  label: ['BEDROCK', 'PHONES, TABLETS'],
  trace: [
    [0, SIZE + 6.2],
    [0, SIZE],
  ],
}

/** A card's half sizes along its length and across it, and its height, in blocks. */
export const CARD = { long: 2.4, short: 1.3, high: 0.5 } as const

/** The names of the parts and what each top shows, as the drawing labels them. */
export const NAMES: Record<Part, string> = {
  world: '00 THE WORLD',
  game: '01 THE GAME',
  power: '02 ASLEEP OR AWAKE',
  door: '03 THE DOOR',
  backups: '04 BACKUPS',
}

export interface PlateAt {
  part: Plate
  index: number
  top: number
  bottom: number
}

const plates: PlateAt[] = (() => {
  const all: PlateAt[] = []
  let y = CUT
  PARTS.forEach((part, index) => {
    if (part === 'world') return
    const top = y - GAP
    const bottom = top - (part === 'backups' ? SHEETS : THICK)
    all.push({ part, index, top, bottom })
    y = bottom
  })
  return all
})()

/** Each part's bottom and top, in blocks: the world's are the island's cut and its grass. */
export const bottomOf = (index: number) => (index === 0 ? CUT : (plates[index - 1] as PlateAt).bottom)
export const topOf = (index: number) => (index === 0 ? GRASS : (plates[index - 1] as PlateAt).top)
export const PLATES = plates
/** The door's top, which the players stand on. */
export const FLOOR = topOf(PARTS.indexOf('door'))

/** The corners of the cube, x and z: back, right, front, left. */
export const CORNERS = [
  [0, 0],
  [SIZE, 0],
  [SIZE, SIZE],
  [0, SIZE],
] as const

export interface Stack {
  unit: number
  width: number
  height: number
  /** Where the island's print sits, and its size. */
  print: { x: number; y: number; width: number; height: number }
  /** Where a place in the world falls on the drawing, at rest. */
  at: (place: Vec3) => Spot
  /** The players at the door, if they are drawn. */
  players: readonly Player[]
  /** Whether the names are drawn beside the parts. */
  named: boolean
  /** Pixels the parts over each part rise when it is read, by index (none for the world). */
  open: readonly number[]
  /** Pixels: the read plate's own rise, how much closer the parts over it come, the world's rise, and the packed gap. */
  rise: number
  closer: number
  world: number
  packed: number
  /** What a plate moves by when it is pulled out. */
  pull: Spot
}

/**
 * How far the parts over plate `index` rise for its whole top to show, pulled out as it is: the
 * lower edge of the part over it clears the plate's far corner by `clear` pixels.
 */
function openOf(at: (place: Vec3) => Spot, index: number, pull: Spot, clear: number): number {
  const front = at([SIZE, bottomOf(index - 1), SIZE])
  const right = at([SIZE, bottomOf(index - 1), 0])
  const left = at([0, bottomOf(index - 1), SIZE])
  const back = at([0, topOf(index), 0])
  const x = back[0] + pull[0]
  const [a, b] = x >= front[0] ? [front, right] : [front, left]
  const edge = a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0]))
  return Math.max(0, edge - (back[1] + pull[1]) + clear)
}

/** Where a part's name stands off: its right-hand corner, at its top (the world's a little below its grass). */
export const nameAt = (at: (place: Vec3) => Spot, index: number) =>
  at([SIZE, index === 0 ? GRASS - 4 : topOf(index), 0])

/** The leftmost and rightmost a player's card and label reach, at rest. */
function playerReach(at: (place: Vec3) => Spot, player: Player): [number, number] {
  const [half, across] = player.long === 'x' ? [CARD.long, CARD.short] : [CARD.short, CARD.long]
  const left = at([player.at[0] - half, FLOOR + CARD.high, player.at[1] + across])
  const label = Math.max(...player.label.map((line) => widthOf(line, TYPE.label, TYPE.spacing)))
  return [left[0] - 10 - label, at([player.at[0] + half, FLOOR, player.at[1] - across])[0]]
}

/**
 * The stack drawn for one print of the island: the camera the print was made with, the room the
 * drawing needs round the print (above it for the parts to rise, beside it for the players and the
 * names), and every rise worked out in pixels of this print.
 */
export function stackOf(
  print: Print,
  drawn: { players: boolean; notes: Record<Part, string> | null },
): Stack {
  const camera = openingCamera(print.across / print.down)
  const size = { width: print.across * print.unit, height: print.down * print.unit }
  const from =
    (x: number, y: number) =>
    (place: Vec3): Spot => {
      const seen = project(camera, place) ?? [0.5, 0.5]
      return [x + seen[0] * size.width, y + seen[1] * size.height]
    }
  const bare = from(0, 0)
  const gap = bare([SIZE, topOf(1), SIZE])[1] - bare([SIZE, CUT, SIZE])[1]
  const pulled = (() => {
    const a = bare([SIZE / 2, FLOOR, SIZE / 2])
    const b = bare([SIZE / 2 + PULLED, FLOOR, SIZE / 2 - PULLED])
    return [b[0] - a[0], b[1] - a[1]] as const
  })()
  const open = PARTS.map((_, index) => (index === 0 ? 0 : openOf(bare, index, pulled, gap * CLEAR)))
  const rise = gap * RISE
  const closer = gap * CLOSER
  const up = Math.max(gap * WORLD, ...open.map((o, k) => (k === 0 ? 0 : o + rise)))
  const players = drawn.players ? [JAVA, BEDROCK] : []
  const lefts = [0, ...players.map((player) => playerReach(bare, player)[0])]
  const { notes } = drawn
  const names = notes
    ? PARTS.map((part, index) => {
        const said = Math.max(widthOf(NAMES[part], TYPE.name, TYPE.spacing), widthOf(notes[part], TYPE.note))
        return nameAt(bare, index)[0] + pulled[0] + TYPE.off + said
      })
    : []
  const right = Math.max(size.width + pulled[0], ...names)
  const snap = (v: number) => Math.ceil(v / print.unit) * print.unit
  const x = snap(-Math.min(...lefts) + 4)
  const y = snap(up + 6)
  const at = from(x, y)
  const bottom = at([SIZE, bottomOf(PARTS.length - 1), SIZE])[1]
  return {
    unit: print.unit,
    width: Math.ceil(x + right + 4),
    height: Math.ceil(bottom + 12),
    print: { x, y, ...size },
    at,
    players,
    named: notes !== null,
    open,
    rise,
    closer,
    world: gap * WORLD,
    packed: gap * (1 - PACKED),
    pull: pulled,
  }
}

/** A plate's sides and top, as the points of three faces: the left, the right and the lid. */
export function slabOf(
  stack: Stack,
  top: number,
  bottom: number,
  box: readonly [number, number, number, number] = [0, 0, SIZE, SIZE],
) {
  const [u0, v0, u1, v1] = box
  const points = (list: Vec3[]) =>
    list
      .map((place) =>
        stack
          .at(place)
          .map((v) => v.toFixed(2))
          .join(','),
      )
      .join(' ')
  return {
    left: points([
      [u0, top, v1],
      [u1, top, v1],
      [u1, bottom, v1],
      [u0, bottom, v1],
    ]),
    right: points([
      [u1, top, v1],
      [u1, top, v0],
      [u1, bottom, v0],
      [u1, bottom, v1],
    ]),
    lid: points([
      [u0, top, v0],
      [u1, top, v0],
      [u1, top, v1],
      [u0, top, v1],
    ]),
  }
}

/** A place on a plate's top as an SVG transform: one unit along x is a block, one along y a block toward the near left. */
export function planeOf(stack: Stack, y: number, u: number, v: number): string {
  const o = stack.at([u, y, v])
  const a = stack.at([u + 1, y, v])
  const b = stack.at([u, y, v + 1])
  const n = (value: number) => value.toFixed(3)
  return `matrix(${n(a[0] - o[0])},${n(a[1] - o[1])},${n(b[0] - o[0])},${n(b[1] - o[1])},${n(o[0])},${n(o[1])})`
}
