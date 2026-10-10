// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { PNG } from 'pngjs'

/**
 * The picture a shared link shows, drawn per server (§15.6). Chat apps want a raster image, so
 * Blockly draws one: rectangles and a pixel font, which is the look the game has and the look
 * of the icons it already ships. Same data as the badge and the status endpoint, so there is
 * one source for what a server is, not three.
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

/** Paper, ink and the two states, as the rest of Blockly uses them. */
const PAPER: Rgb = [0xf7, 0xf4, 0xec]
const INK: Rgb = [0x1c, 0x1b, 0x17]
const MUTED: Rgb = [0x6b, 0x67, 0x5c]
const GRASS: Rgb = [0x6c, 0xc2, 0x4a]
const ASLEEP: Rgb = [0x8f, 0x86, 0xd6]

type Rgb = readonly [number, number, number]

export interface CardView {
  name: string
  awake: boolean
  online: number
  maxPlayers: number
  gameVersion: string
  /** The server type, where it is not plain Minecraft; null says nothing rather than "VANILLA". */
  serverType: string | null
  invited: boolean
}

export function serverCard(view: CardView): Buffer {
  const canvas = new Canvas(WIDTH, HEIGHT, PAPER)
  const state = view.awake ? GRASS : ASLEEP
  // A band of the state's own colour, so a glance says running or asleep before any word does.
  canvas.fill(0, 0, WIDTH, 16, state)

  // The whole block is measured before any of it is drawn, so one line and two sit the same:
  // a little above the middle, which is where a preview is cropped last.
  const scale = view.name.length > 16 ? 8 : 11
  const name = wrap(view.name, Math.floor((WIDTH - MARGIN * 2) / (scale * 6)), 2)
  const rows: Array<{ text: string; scale: number; colour: Rgb; gap: number }> = [
    ...(view.invited ? [{ text: "YOU'RE INVITED TO", scale: 4, colour: MUTED, gap: 28 }] : []),
    ...name.map((line) => ({ text: line, scale, colour: INK, gap: scale * 3 })),
    {
      text: view.awake ? `${view.online} OF ${view.maxPlayers} PLAYING` : 'ASLEEP. IT WAKES WHEN YOU JOIN',
      scale: 5,
      colour: view.awake ? INK : MUTED,
      gap: 22,
    },
    {
      text: `MINECRAFT ${view.gameVersion}${view.serverType === null ? '' : ` ${view.serverType.toUpperCase()}`}`,
      scale: 4,
      colour: MUTED,
      gap: 0,
    },
  ]
  // The last row's gap is below it, so the stack's own height leaves it out.
  const stack = rows.reduce((total, row) => total + row.scale * 7 + row.gap, 0) - (rows.at(-1)?.gap ?? 0)
  let y = Math.round((HEIGHT - stack) / 2) - 24
  for (const row of rows) {
    canvas.text(MARGIN, y, row.text, row.scale, row.colour)
    y += row.scale * 7 + row.gap
  }

  canvas.text(MARGIN, HEIGHT - MARGIN - 4 * 7, 'BLOCKLY', 4, MUTED)
  // A block of the state's colour in the corner, the size of one big pixel: the mark, not a logo.
  canvas.fill(WIDTH - MARGIN - 48, HEIGHT - MARGIN - 48, 48, 48, state)
  return canvas.png()
}

/** Words onto at most `lines` lines of `width` characters, the last one cut with a full stop. */
function wrap(text: string, width: number, lines: number): string[] {
  const words = text
    .toUpperCase()
    .replace(/[^A-Z0-9 .,:'!?/*()+%"-]/g, '')
    .trim()
    .split(/\s+/)
  const out: string[] = []
  let line = ''
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`
    if (next.length <= width) {
      line = next
      continue
    }
    out.push(line === '' ? word.slice(0, width) : line)
    line = line === '' ? '' : word
    if (out.length === lines) break
  }
  if (out.length < lines && line !== '') out.push(line)
  if (out.length === 0) return ['A MINECRAFT SERVER']
  const last = out[out.length - 1] as string
  if (last.length > width) out[out.length - 1] = `${last.slice(0, width - 1)}.`
  return out
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
const FONT: Record<string, string> = {
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
