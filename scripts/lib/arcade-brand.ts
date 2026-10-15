// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals in the Arcade's world, as `arcade-world.ts` builds it: the mark in blocks on the hall's
 * two arcade screens, Ink on the lit one and Paper on Ink on the other, the brand's two
 * colourways (`brand/README.md`); the games' pads; and the horizontal lockup, Ink on Paper, as the
 * map art of every Cubepals sign, with the Paper each sign hangs on (`minecraft/arcade/signs.ts`).
 * Not the maps or the games.
 *
 * The brand's files are Cubepals' own, not the repository's licence (`brand/LICENSE.md`). In the
 * hub, NetherGames' CC BY 4.0 map, the mark is built in blocks; at the CC BY-SA maps, a sign is
 * map items hung on a plain backing, kept apart from the map's blocks.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { PNG } from 'pngjs'
import type { Block } from '../../apps/control/src/minecraft/arcade/datapack.ts'
import { FLOOR_PAD, FLOOR_SIGN } from '../../apps/control/src/minecraft/arcade/floor.ts'
import { HUB_SIGN, PADS } from '../../apps/control/src/minecraft/arcade/hub.ts'
import { PARKOUR_SIGN } from '../../apps/control/src/minecraft/arcade/parkour.ts'
import { PIT_SIGNS } from '../../apps/control/src/minecraft/arcade/pit.ts'
import { SIGN_ART, signBacking } from '../../apps/control/src/minecraft/arcade/signs.ts'

/** Every Cubepals sign in the world, each on its backing. */
const SIGNS = [HUB_SIGN, PARKOUR_SIGN, FLOOR_SIGN, ...PIT_SIGNS]

/**
 * The mark at eleven blocks square, drawn rather than scaled down: a square, two circles and the
 * square with its S-curve bite, each five blocks with a block between them, as a viewer sees it.
 */
const MARK = [
  '#####..###.',
  '#####.#####',
  '#####.#####',
  '#####.#####',
  '#####..###.',
  '...........',
  '.###..##...',
  '#####.###..',
  '#####.#####',
  '#####.#####',
  '.###..#####',
]

/**
 * The mark drawn on a screen: `left` is the block at the viewer's top left, and `right` the
 * direction the viewer's right is along x (+1 or -1). Only the mark's own blocks are set.
 */
function mark(left: readonly [number, number, number], right: 1 | -1, block: string): string[] {
  const [x, y, z] = left
  return MARK.flatMap((row, r) =>
    [...row].flatMap((cell, c) =>
      cell === '#' ? [`setblock ${x + c * right} ${y - r} ${z} minecraft:${block}`] : [],
    ),
  )
}

/** A game's pad: Ink, three blocks square, in a ring of Paper, as the datapack finds it by its middle. */
const pad = ([x, y, z]: Block): string[] => [
  `fill ${x - 2} ${y} ${z - 2} ${x + 2} ${y} ${z + 2} minecraft:quartz_block`,
  `fill ${x - 1} ${y} ${z - 1} ${x + 1} ${y} ${z + 1} minecraft:black_concrete`,
]

/**
 * The hall's two screens, the pads and the signs' backings. The big ARCADE cabinet on the north wall faces the hall:
 * its glowing screen loses NetherGames' letters and shows the mark in Ink. The screen over the
 * entrance faces the other way: its letters come off the front, its back turns Ink, and the mark
 * is Paper. Then each game's pad, on the balcony and at the falling floor's lake, and the Paper
 * each sign hangs on.
 */
export const BRAND_COMMANDS: readonly string[] = [
  'fill 166 75 1354 185 87 1354 minecraft:sea_lantern replace minecraft:yellow_concrete',
  'fill 166 75 1354 185 87 1354 minecraft:sea_lantern replace minecraft:orange_concrete',
  ...mark([170, 86, 1354], 1, 'black_concrete'),
  'fill 169 84 1446 182 96 1446 minecraft:air replace minecraft:orange_concrete',
  'fill 170 85 1447 181 95 1447 minecraft:black_concrete',
  'fill 169 84 1447 182 96 1447 minecraft:black_concrete replace minecraft:nether_brick_stairs',
  ...mark([180, 95, 1446], -1, 'quartz_block'),
  ...[...PADS.map((p) => p.middle), FLOOR_PAD].flatMap(pad),
  // Paper behind each sign's frames, which hang on it.
  ...SIGNS.map((sign) => {
    const [from, to] = signBacking(sign)
    return `fill ${from.join(' ')} ${to.join(' ')} minecraft:quartz_block`
  }),
]

/** The map palette's nearest to Paper (quartz, at full shade) and to Ink (black, at full shade). */
const PAPER = 14 * 4 + 2
const INK = 29 * 4 + 2

/** One map's NBT, gzipped, as 26.2 keeps it in `data/minecraft/maps/<id>.dat`. */
function mapFile(colors: Uint8Array): Buffer {
  const parts: Buffer[] = []
  const name = (s: string) => {
    const b = Buffer.from(s, 'utf8')
    const len = Buffer.alloc(2)
    len.writeUInt16BE(b.length)
    parts.push(len, b)
  }
  const tag = (type: number, key: string) => {
    parts.push(Buffer.from([type]))
    name(key)
  }
  const int = (key: string, value: number) => {
    tag(3, key)
    const b = Buffer.alloc(4)
    b.writeInt32BE(value)
    parts.push(b)
  }
  const byte = (key: string, value: number) => {
    tag(1, key)
    parts.push(Buffer.from([value]))
  }
  tag(10, '')
  int('DataVersion', 4903)
  tag(10, 'data')
  tag(8, 'dimension')
  name('minecraft:overworld')
  int('xCenter', 0)
  int('zCenter', 0)
  byte('scale', 0)
  byte('locked', 1)
  byte('trackingPosition', 0)
  byte('unlimitedTracking', 0)
  tag(7, 'colors')
  const len = Buffer.alloc(4)
  len.writeInt32BE(colors.length)
  parts.push(len, Buffer.from(colors))
  parts.push(Buffer.from([0, 0]))
  return gzipSync(Buffer.concat(parts))
}

/**
 * Writes the lockup's maps into a world, for each size of sign: the lockup, Ink on Paper, centred
 * on the sign's canvas of 128 pixels a frame, one map a frame, numbered from the size's first map
 * left to right and top to bottom.
 */
export function writeSignMaps(level: string, lockupPng: string): void {
  const png = PNG.sync.read(readFileSync(lockupPng))
  const dir = join(level, 'data', 'minecraft', 'maps')
  mkdirSync(dir, { recursive: true })
  for (const { columns, rows, firstMap } of Object.values(SIGN_ART)) {
    const inked = canvas(png, columns * 128, rows * 128)
    for (let i = 0; i < rows * columns; i++) {
      const [col, row] = [i % columns, Math.floor(i / columns)]
      writeFileSync(join(dir, `${firstMap + i}.dat`), mapFile(tile(inked, col * 128, row * 128)))
    }
  }
}

/** One map's 128 pixels square of a canvas, from its top left: Ink where the canvas is inked. */
function tile(inked: (px: number, py: number) => boolean, left: number, top: number): Uint8Array {
  const colors = new Uint8Array(128 * 128)
  for (let i = 0; i < colors.length; i++)
    colors[i] = inked(left + (i % 128), top + Math.floor(i / 128)) ? INK : PAPER
  return colors
}

/** Whether each pixel of a canvas is Ink: more than half covered by the lockup, scaled to fit it. */
function canvas(png: PNG, width: number, height: number): (px: number, py: number) => boolean {
  const scale = Math.min((width * 0.92) / png.width, (height * 0.8) / png.height)
  const [w, h] = [Math.round(png.width * scale), Math.round(png.height * scale)]
  const [ox, oy] = [Math.round((width - w) / 2), Math.round((height - h) / 2)]
  return (px, py) => {
    const [x0, x1] = [Math.floor((px - ox) / scale), Math.ceil((px + 1 - ox) / scale)]
    const [y0, y1] = [Math.floor((py - oy) / scale), Math.ceil((py + 1 - oy) / scale)]
    let alpha = 0
    let count = 0
    for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
        alpha += png.data[(y * png.width + x) * 4 + 3] ?? 0
        count++
      }
    return count > 0 && alpha / count > 127
  }
}
