// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type JoinRange, versionsThatJoin } from '@blockly/contracts'
import { PNG } from 'pngjs'

/**
 * The picture a shared link shows, drawn per server (§15.6). Chat apps want a raster image, so
 * Blockly draws one: rectangles and a pixel font, which is the look the game has and the look
 * of the icons it already ships. The one thing not drawn here is Cubepals' lockup: that is the
 * brand's own PNG, laid over the canvas, so it is never redrawn or recoloured. Same data as the
 * badge and the status endpoint, so there is one source for what a server is, not three.
 *
 * The encoding is `pngjs`. Rendering an SVG instead — the badge's own markup through
 * `@resvg/resvg-js` — was tried on 2026-09-23 and dropped: it draws real type, but it draws it
 * with the system's fonts, and a slim server image has none. With `loadSystemFonts` off it
 * rendered a 485-byte blank. Making it work would mean committing a font and its licence and
 * taking on a native binary, for a picture whose whole job is to render on someone else's
 * machine without surprises.
 */

const WIDTH = 1200
const HEIGHT = 630
const MARGIN = 72
const BAND = 16

/** Ink and Paper, the brand's two colours (brand/README.md), and the product's lighter ink. */
const PAPER: Rgb = [0xf8, 0xf7, 0xf5]
const INK: Rgb = [0x0d, 0x0d, 0x0d]
const SUBTLE: Rgb = [0x5b, 0x59, 0x54]
/** The two states as the product shows them (tokens.json): a strong colour and the fill behind it. */
const ONLINE = { strong: [0x8a, 0x5a, 0x00], soft: [0xff, 0xe9, 0xbd] } as const
const SLEEPING = { strong: [0x4d, 0x47, 0xb8], soft: [0xe3, 0xe1, 0xfb] } as const
/** A block's edge, the product's 2px drawn at the size a preview shrinks this picture to. */
const EDGE = 4
/** Room around the words inside a block. */
const PAD_X = 20
const PAD_Y = 14

type Rgb = readonly [number, number, number]

/**
 * The brand's own horizontal lockup, the mark and the lowercase word as `brand/png/` draws them,
 * at a fifth of its size: 400 by 82. Read once, as the module loads, so a build without the file
 * fails to start (and its tests fail) instead of failing the first link someone shares. The
 * control plane's Dockerfile copies it to the same place under /app.
 */
export const LOCKUP_FILE = fileURLToPath(
  new URL('../../../../../brand/png/lockup-horizontal.png', import.meta.url),
)
const LOCKUP = shrink(PNG.sync.read(readFileSync(LOCKUP_FILE)), 5)

export interface CardView {
  name: string
  awake: boolean
  online: number
  maxPlayers: number
  gameVersion: string
  /** Which versions join, as every page words it. */
  joins: JoinRange
  invited: boolean
}

interface Row {
  text: string
  scale: number
  colour: Rgb
  gap: number
  /** Drawn on a block of this fill with an Ink edge, as the product draws a status. */
  block?: Rgb
}

/** The line under the state: the versions that join. The server type is for its owner's pages, not a link preview. */
export const versionRow = (view: Pick<CardView, 'gameVersion' | 'joins'>): string =>
  `MINECRAFT ${versionsThatJoin(view.gameVersion, view.joins)}`.toUpperCase()

export function serverCard(view: CardView): Buffer {
  const canvas = new Canvas(WIDTH, HEIGHT, PAPER)
  const state = view.awake ? ONLINE : SLEEPING
  // A band of the state's own colour, so a glance says running or asleep before any word does.
  canvas.fill(0, 0, WIDTH, BAND, state.strong)

  // The whole block is measured before any of it is drawn, so one line and two sit the same: in
  // the middle of what the band and the lockup leave, a little high, which is where a preview is
  // cropped last.
  const scale = view.name.length > 16 ? 8 : 11
  const name = wrap(view.name, Math.floor((WIDTH - MARGIN * 2) / (scale * 6)), 2)
  const rows: Row[] = [
    ...(view.invited ? [{ text: "YOU'RE INVITED TO", scale: 4, colour: SUBTLE, gap: 28 }] : []),
    ...name.map((line) => ({ text: line, scale, colour: INK, gap: scale * 3 })),
    {
      text: view.awake ? `${view.online} OF ${view.maxPlayers} PLAYING` : 'ASLEEP. IT WAKES WHEN YOU JOIN',
      scale: 5,
      colour: state.strong,
      gap: 24,
      block: state.soft,
    },
    {
      text: versionRow(view),
      scale: 4,
      colour: SUBTLE,
      gap: 0,
    },
  ]
  const height = (row: Row) => row.scale * 7 + (row.block === undefined ? 0 : (PAD_Y + EDGE) * 2)
  // The last row's gap is below it, so the stack's own height leaves it out.
  const stack = rows.reduce((total, row) => total + height(row) + row.gap, 0) - (rows.at(-1)?.gap ?? 0)
  const lockupTop = HEIGHT - MARGIN - LOCKUP.height
  let y = BAND + Math.round((lockupTop - BAND - stack) / 2) - 16
  for (const row of rows) {
    if (row.block === undefined) canvas.text(MARGIN, y, row.text, row.scale, row.colour)
    else {
      const width = row.text.length * row.scale * 6 - row.scale + (PAD_X + EDGE) * 2
      canvas.fill(MARGIN, y, width, height(row), INK)
      canvas.fill(MARGIN + EDGE, y + EDGE, width - EDGE * 2, height(row) - EDGE * 2, row.block)
      canvas.text(MARGIN + EDGE + PAD_X, y + EDGE + PAD_Y, row.text, row.scale, row.colour)
    }
    y += height(row) + row.gap
  }

  canvas.draw(MARGIN, lockupTop, LOCKUP)
  return canvas.png()
}

/** An RGBA picture, its colour already weighted by how opaque each pixel is. */
interface Picture {
  width: number
  height: number
  /** Red, green and blue times opacity, then opacity, each from 0 to 1. */
  pixels: Float32Array
}

/** A PNG made `factor` times smaller, each new pixel the average of the square it covers. */
function shrink(png: PNG, factor: number): Picture {
  const width = Math.floor(png.width / factor)
  const height = Math.floor(png.height / factor)
  const pixels = new Float32Array(width * height * 4)
  const area = factor * factor * 255
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++) {
          const at = ((y * factor + dy) * png.width + x * factor + dx) * 4
          const alpha = (png.data[at + 3] as number) / 255
          for (let channel = 0; channel < 3; channel++)
            (pixels[to + channel] as number) += ((png.data[at + channel] as number) * alpha) / area
          ;(pixels[to + 3] as number) += (png.data[at + 3] as number) / area
        }
    }
  return { width, height, pixels }
}

/** Words onto at most `lines` lines of `width` characters, a name cut short ending in "...". */
function wrap(text: string, width: number, lines: number): string[] {
  const words = text
    .toUpperCase()
    .replace(/[^A-Z0-9 .,:'!?/*()+%"-]/g, '')
    .trim()
    .split(/\s+/)
  const out: string[] = []
  let line = ''
  let cut = false
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`
    if (next.length <= width) {
      line = next
      continue
    }
    out.push(line === '' ? word.slice(0, width) : line)
    // A word longer than the line is cut; one that starts the line after the last is left out.
    cut = cut || line === '' || out.length === lines
    line = line === '' ? '' : word
    if (out.length === lines) break
  }
  if (out.length < lines && line !== '') out.push(line)
  if (out.length === 0) return ['A MINECRAFT SERVER']
  out[out.length - 1] = ending(out[out.length - 1] as string, cut, width)
  return out
}

/** The last line of a name, ending in "..." within `width` characters where the name didn't fit. */
function ending(line: string, cut: boolean, width: number): string {
  if (!cut && line.length <= width) return line
  return `${line.length + 3 <= width ? line : line.slice(0, width - 3).trimEnd()}...`
}

/** Pixels in memory, and the PNG they become. Nothing here knows what it is drawing. */
class Canvas {
  readonly #width: number
  readonly #height: number
  readonly #pixels: Uint8Array

  constructor(width: number, height: number, background: Rgb) {
    this.#width = width
    this.#height = height
    this.#pixels = new Uint8Array(width * height * 3)
    for (let at = 0; at < this.#pixels.length; at += 3) {
      this.#pixels[at] = background[0]
      this.#pixels[at + 1] = background[1]
      this.#pixels[at + 2] = background[2]
    }
  }

  fill(x: number, y: number, width: number, height: number, colour: Rgb): void {
    for (let row = Math.max(0, y); row < Math.min(this.#height, y + height); row++)
      for (let column = Math.max(0, x); column < Math.min(this.#width, x + width); column++) {
        const at = (row * this.#width + column) * 3
        this.#pixels[at] = colour[0]
        this.#pixels[at + 1] = colour[1]
        this.#pixels[at + 2] = colour[2]
      }
  }

  /** A picture laid over what is there, as its own opacity says. */
  draw(x: number, y: number, picture: Picture): void {
    for (let row = 0; row < picture.height; row++)
      for (let column = 0; column < picture.width; column++) {
        const from = (row * picture.width + column) * 4
        const at = ((y + row) * this.#width + x + column) * 3
        const alpha = picture.pixels[from + 3] as number
        for (let channel = 0; channel < 3; channel++)
          this.#pixels[at + channel] = Math.round(
            (picture.pixels[from + channel] as number) * 255 +
              (this.#pixels[at + channel] as number) * (1 - alpha),
          )
      }
  }

  /** One line of text, each glyph pixel drawn as a `scale`-sized square. */
  text(x: number, y: number, text: string, scale: number, colour: Rgb): void {
    let at = x
    for (const character of text) {
      const glyph = FONT[character] ?? FONT['?']
      if (glyph !== undefined)
        for (let row = 0; row < 7; row++) {
          const bits = Number.parseInt(glyph.slice(row * 2, row * 2 + 2), 16)
          for (let column = 0; column < 5; column++)
            if ((bits >> (4 - column)) & 1)
              this.fill(at + column * scale, y + row * scale, scale, scale, colour)
        }
      at += scale * 6
    }
  }

  png(): Buffer {
    // The encoding is `pngjs`, which is what that library is for; what Blockly keeps is the
    // drawing above. The canvas is RGB, and PNG wants a fourth byte for opacity.
    const image = new PNG({ width: this.#width, height: this.#height })
    for (let at = 0, to = 0; at < this.#pixels.length; at += 3, to += 4) {
      image.data[to] = this.#pixels[at] as number
      image.data[to + 1] = this.#pixels[at + 1] as number
      image.data[to + 2] = this.#pixels[at + 2] as number
      image.data[to + 3] = 255
    }
    return PNG.sync.write(image)
  }
}

/**
 * The letters, five wide and seven tall, one hex byte a row with the low five bits drawn. Only
 * the shapes a server's name, its numbers and its state need; anything else becomes a question
 * mark rather than a hole.
 */
export const FONT: Record<string, string> = {
  A: '0e11111f111111',
  B: '1e11111e11111e',
  C: '0e11101010110e',
  D: '1e11111111111e',
  E: '1f10101e10101f',
  F: '1f10101e101010',
  G: '0e11101711110f',
  H: '1111111f111111',
  I: '0e04040404040e',
  J: '0702020202120c',
  K: '11121418141211',
  L: '1010101010101f',
  M: '111b1515111111',
  N: '11191513111111',
  O: '0e11111111110e',
  P: '1e11111e101010',
  Q: '0e11111115120d',
  R: '1e11111e141211',
  S: '0f10100e01011e',
  T: '1f040404040404',
  U: '1111111111110e',
  V: '11111111110a04',
  W: '11111115151b11',
  X: '11110a040a1111',
  Y: '11110a04040404',
  Z: '1f01020408101f',
  '0': '0e11131519110e',
  '1': '040c040404040e',
  '2': '0e11010204081f',
  '3': '1f02040201110e',
  '4': '02060a121f0202',
  '5': '1f101e0101110e',
  '6': '0608101e11110e',
  '7': '1f010204080808',
  '8': '0e11110e11110e',
  '9': '0e11110f01020c',
  ' ': '00000000000000',
  '.': '00000000000c0c',
  ',': '000000000c0c08',
  ':': '000c0c000c0c00',
  '-': '0000000e000000',
  "'": '04040800000000',
  '!': '04040404040004',
  '?': '0e110102040004',
  '/': '01020204080810',
  '*': '0000040e040000',
  '(': '02040808080402',
  ')': '08040202020408',
  '+': '0004041f040400',
  '%': '191a0204080b13',
  '"': '0a0a0000000000',
}
