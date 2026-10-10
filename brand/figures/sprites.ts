// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The landing page's people, drawn for email: Moss, Kai, Noor and the worker, front view, to the
 * game's own proportions (a head 8 pixels square, a body 8 by 12, arms and legs 4 by 12), each
 * part in the grey its model gives it (apps/web/src/landing/engine/models.ts) and printed in one-bit dither like the
 * landing's chunk. Three poses: waving, checking a clipboard, and hanging by the hands from the
 * top edge of an email's card.
 *
 * Written straight to PNG, and to GIF for the wave: mail apps don't show SVG, and GIF is the only
 * moving picture they all play (Outlook on Windows shows the first frame, a raised hand). An ink
 * edge and a paper outline keep the figure readable where a mail app turns the email dark and
 * leaves pictures alone.
 */
import { deflateSync } from 'node:zlib'

export type Look = {
  skin: number
  hair?: number
  style?: 'short' | 'long' | 'cap'
  cap?: number
  shirt: number
  sleeves: boolean
  trousers: number
  shoes: number
  helmet?: boolean
}

// The friends and the worker, as apps/web/src/landing/engine/models.ts dresses them.
export const MOSS: Look = {
  skin: 250,
  hair: 30,
  style: 'short',
  shirt: 150,
  sleeves: true,
  trousers: 60,
  shoes: 30,
}
export const KAI: Look = {
  skin: 225,
  hair: 30,
  style: 'cap',
  cap: 70,
  shirt: 250,
  sleeves: false,
  trousers: 105,
  shoes: 40,
}
export const NOOR: Look = {
  skin: 250,
  hair: 105,
  style: 'long',
  shirt: 40,
  sleeves: true,
  trousers: 220,
  shoes: 40,
}
export const WORKER: Look = { skin: 250, shirt: 225, sleeves: true, trousers: 190, shoes: 60, helmet: true }

const INK = [0x18, 0x18, 0x18]
const PAPER = [0xf8, 0xf7, 0xf5]
const TORCH = [0xff, 0xb0, 0x1f]
const TORCH_TONE = -1

/** A figure pixel: its tone (0–255, or the torch) and the body part it belongs to. */
type Cell = { tone: number; part: string }

/**
 * Figure pixels drawn anywhere, cropped once the pose is done. A limb that swings is drawn on its
 * own canvas and laid on top `turned` about its joint: limbs in the game turn whole, they never bend.
 */
class Canvas {
  cells = new Map<string, Cell & { x: number; y: number }>()
  turned: Array<{ limb: Canvas; px: number; py: number; degrees: number }> = []
  rect(x: number, y: number, w: number, h: number, tone: number, part: string) {
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++) this.cells.set(`${i},${j}`, { x: i, y: j, tone, part })
  }
  /** The cell at a point in figure pixels; turned limbs first, as they lie on top. */
  at(fx: number, fy: number): Cell | undefined {
    for (const t of this.turned) {
      const a = (-t.degrees * Math.PI) / 180
      const dx = fx - t.px
      const dy = fy - t.py
      const hit = t.limb.cells.get(
        `${Math.floor(t.px + dx * Math.cos(a) - dy * Math.sin(a))},${Math.floor(t.py + dx * Math.sin(a) + dy * Math.cos(a))}`,
      )
      if (hit) return hit
    }
    return this.cells.get(`${Math.floor(fx)},${Math.floor(fy)}`)
  }
  /** Every drawn corner, turned limbs where they land. */
  corners(): Array<[number, number]> {
    const own = [...this.cells.values()].flatMap(
      (p): Array<[number, number]> => [
        [p.x, p.y],
        [p.x + 1, p.y + 1],
      ],
    )
    const limbs = this.turned.flatMap((t) => {
      const a = (t.degrees * Math.PI) / 180
      return t.limb
        .corners()
        .map(([x, y]): [number, number] => [
          t.px + (x - t.px) * Math.cos(a) - (y - t.py) * Math.sin(a),
          t.py + (x - t.px) * Math.sin(a) + (y - t.py) * Math.cos(a),
        ])
    })
    return [...own, ...limbs]
  }
}

type Eyes = 'ahead' | 'down' | 'shut'

function head(c: Canvas, look: Look, hx: number, hy: number, eyes: Eyes) {
  c.rect(hx, hy, 8, 8, look.skin, 'head')
  if (look.helmet) {
    c.rect(hx, hy, 8, 3, 170, 'helmet')
    c.rect(hx + 3, hy + 1, 2, 1, TORCH_TONE, 'helmet') // the lamp, lit: the one warm colour, meaning on
  } else if (look.style === 'cap') {
    c.rect(hx, hy, 8, 2, look.cap ?? 70, 'head')
    c.rect(hx, hy + 2, 8, 1, Math.max(0, (look.cap ?? 70) - 30), 'head')
  } else if (look.hair !== undefined) {
    const side = look.style === 'long' ? 6 : 2
    c.rect(hx, hy, 8, 2, look.hair, 'head')
    c.rect(hx, hy + 2, 1, side, look.hair, 'head')
    c.rect(hx + 7, hy + 2, 1, side, look.hair, 'head')
  }
  if (eyes === 'shut') {
    c.rect(hx + 1, hy + 5, 2, 1, 110, 'head')
    c.rect(hx + 5, hy + 5, 2, 1, 110, 'head')
  } else {
    c.rect(hx + 1, hy + 4, 2, 2, 250, 'head')
    c.rect(hx + 5, hy + 4, 2, 2, 250, 'head')
    // Ahead, the pupils fill the inner column; looking down, only its lower half.
    const py = eyes === 'down' ? hy + 5 : hy + 4
    const ph = eyes === 'down' ? 1 : 2
    // Solid ink, not dithered: a speckled pupil reads as a squint.
    c.rect(hx + 2, py, 1, ph, 0, 'head')
    c.rect(hx + 5, py, 1, ph, 0, 'head')
  }
  c.rect(hx + 3, hy + 6, 2, 1, Math.max(0, look.skin - 70), 'head') // mouth
}

/** Body, legs and shoes, from the shoulders at (x, y). Long hair falls onto the shoulders. */
function torso(c: Canvas, look: Look, x: number, y: number) {
  c.rect(x, y, 8, 12, look.shirt, 'body')
  if (look.style === 'long' && look.hair !== undefined) {
    c.rect(x, y, 2, 3, look.hair, 'body')
    c.rect(x + 6, y, 2, 3, look.hair, 'body')
  }
  c.rect(x, y + 12, 4, 12, look.trousers, 'leg-l')
  c.rect(x + 4, y + 12, 4, 12, Math.max(0, look.trousers - 18), 'leg-r')
  c.rect(x, y + 22, 4, 2, look.shoes, 'leg-l')
  c.rect(x + 4, y + 22, 4, 2, look.shoes, 'leg-r')
}

/**
 * An arm, 4 pixels wide, as rows listed from the hand's tip to the shoulder; each row's x lets it
 * bend. The hand is the 3 rows at the tip; a sleeve covers the rest, or 4 rows when it's short.
 */
function arm(c: Canvas, look: Look, rows: Array<[number, number]>, part: string, grip = false) {
  const sleeveFrom = look.sleeves ? 3 : rows.length - 4
  rows.forEach(([x, y], i) => {
    const tone = i >= sleeveFrom ? look.shirt : i === 0 && grip ? Math.max(0, look.skin - 40) : look.skin
    c.rect(x, y, 4, 1, tone, part)
  })
}

/** Rows from (x, from) to (x, to), one a pixel, in that order. */
const column = (x: number, from: number, to: number): Array<[number, number]> =>
  Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => [x, from + i * Math.sign(to - from)])

/** Hanging by both hands, the fingers on the top row, which is the card's edge. */
function hangingPose(look: Look): Canvas {
  const c = new Canvas()
  arm(c, look, column(0, 0, 11), 'arm-l', true)
  arm(c, look, column(12, 0, 11), 'arm-r', true)
  head(c, look, 4, 4, 'ahead')
  torso(c, look, 4, 12)
  return c
}

/** Standing, one hand up, the arm turned `degrees` out from the shoulder. */
function wavingPose(look: Look, degrees: number): Canvas {
  const c = new Canvas()
  head(c, look, 4, 0, 'ahead')
  torso(c, look, 4, 8)
  arm(c, look, column(0, 19, 8), 'arm-l')
  const limb = new Canvas()
  arm(limb, look, column(12, -2, 9), 'arm-r')
  c.turned.push({ limb, px: 12.5, py: 9.5, degrees })
  return c
}

/** Standing, looking down at a clipboard held in both hands, the top lines ticked. */
function clipboardPose(look: Look): Canvas {
  const c = new Canvas()
  head(c, look, 4, 0, 'down')
  torso(c, look, 4, 8)
  c.rect(3, 12, 10, 12, 140, 'board')
  c.rect(4, 14, 8, 9, 250, 'sheet')
  c.rect(6, 12, 4, 2, 40, 'clip')
  for (const [row, ticked] of [
    [16, true],
    [18, true],
    [20, false],
  ] as const) {
    c.rect(5, row, 1, 1, ticked ? 20 : 170, 'sheet')
    c.rect(7, row, 4, 1, 90, 'sheet')
  }
  arm(c, look, column(0, 15, 8), 'arm-l')
  arm(c, look, column(12, 15, 8), 'arm-r')
  return c
}

type Box = { x0: number; y0: number; x1: number; y1: number }

/**
 * The drawn pixels plus one of air on every side but `flush`, where the figure meets the card:
 * the hanging hands touch its top edge, the standing feet its top border.
 */
function bounds(canvases: Canvas[], flush: 'top' | 'bottom'): Box {
  const all = canvases.flatMap((c) => c.corners())
  const xs = all.map(([x]) => x)
  const ys = all.map(([, y]) => y)
  return {
    x0: Math.floor(Math.min(...xs)) - 1,
    x1: Math.ceil(Math.max(...xs)) - 1 + 1,
    y0: Math.floor(Math.min(...ys)) - (flush === 'top' ? 0 : 1),
    y1: Math.ceil(Math.max(...ys)) - 1 + (flush === 'bottom' ? 0 : 1),
  }
}

// 4×4 ordered dither, as the landing prints its chunk.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

/** CSS pixels per figure pixel. Each dither dot is one CSS pixel, drawn at two for sharp screens. */
export const PX = 3
const DOT = 2
const S = PX * DOT

/**
 * The figure as RGBA. Inside, each part is dithered and an ink line parts it from its neighbours
 * (the head from the arms beside it, the legs from each other). Outside, one dot of ink, so a pale
 * shirt still has an edge on a white card, then two of paper, so it still has one on a dark card.
 */
function rasterise(c: Canvas, box: Box): { w: number; h: number; rgba: Uint8Array } {
  const w = (box.x1 - box.x0 + 1) * S
  const h = (box.y1 - box.y0 + 1) * S
  const rgba = new Uint8Array(w * h * 4)
  // Sampled at each image pixel's centre, so a turned limb's edge falls between pixels.
  const at = (x: number, y: number) =>
    x < 0 || y < 0 ? undefined : c.at((x + 0.5) / S + box.x0, (y + 0.5) / S + box.y0)
  const ring = 3 * DOT
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const cell = at(x, y)
      let rgb: number[] | null = null
      if (cell) {
        const left = at(x - DOT, y)
        const up = at(x, y - DOT)
        const seam = (left && left.part !== cell.part) || (up && up.part !== cell.part)
        if (cell.tone === TORCH_TONE) rgb = TORCH
        else if (seam) rgb = INK
        else {
          const threshold = ((BAYER[Math.floor(y / DOT) % 4][Math.floor(x / DOT) % 4] + 0.5) / 16) * 255
          rgb = cell.tone > threshold ? PAPER : INK
        }
      } else {
        let nearest = Infinity
        for (let dy = -ring; dy <= ring; dy += DOT)
          for (let dx = -ring; dx <= ring; dx += DOT)
            if (x + dx < w && y + dy < h && at(x + dx, y + dy))
              nearest = Math.min(nearest, Math.max(Math.abs(dx), Math.abs(dy)))
        if (nearest <= DOT) rgb = INK
        else if (nearest <= ring) rgb = PAPER
      }
      if (rgb) rgba.set([...rgb, 255], (y * w + x) * 4)
    }
  return { w, h, rgba }
}

// ── PNG ────────────────────────────────────────────────────────────────────

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ])
}

// ── GIF ────────────────────────────────────────────────────────────────────

/** GIF's LZW, as omggif writes it: codes grow from 3 bits, the table resets at 4096. */
function lzw(indices: Uint8Array, minCode: number): Buffer {
  const clear = 1 << minCode
  const eoi = clear + 1
  let size = minCode + 1
  let next = eoi + 1
  let table = new Map<number, number>()
  const out: number[] = []
  let acc = 0
  let bits = 0
  const write = (code: number) => {
    acc |= code << bits
    bits += size
    while (bits >= 8) {
      out.push(acc & 0xff)
      acc >>>= 8
      bits -= 8
    }
  }
  write(clear)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const key = prefix * 256 + indices[i]
    const found = table.get(key)
    if (found !== undefined) {
      prefix = found
      continue
    }
    write(prefix)
    if (next === 4096) {
      write(clear)
      table = new Map()
      size = minCode + 1
      next = eoi + 1
    } else {
      if (next >= 1 << size) size++
      table.set(key, next++)
    }
    prefix = indices[i]
  }
  write(prefix)
  write(eoi)
  if (bits > 0) out.push(acc & 0xff)
  const blocks: number[] = [minCode]
  for (let i = 0; i < out.length; i += 255) {
    const part = out.slice(i, i + 255)
    blocks.push(part.length, ...part)
  }
  blocks.push(0)
  return Buffer.from(blocks)
}

/** Frames of the same size in ink, paper and torch on transparency, played `repeats` more times. */
function gif(
  w: number,
  h: number,
  frames: Array<{ rgba: Uint8Array; delay: number }>,
  repeats: number,
): Buffer {
  const palette = [INK, PAPER, TORCH, [0, 0, 0]]
  const CLEAR = 3
  const u16 = (n: number) => [n & 0xff, n >> 8]
  const parts: Buffer[] = [
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([...u16(w), ...u16(h), 0x91, CLEAR, 0, ...palette.flat()]),
    Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, ...u16(repeats), 0]),
  ]
  for (const f of frames) {
    const indices = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const [r, g, b, a] = f.rgba.subarray(i * 4, i * 4 + 4)
      indices[i] = a === 0 ? CLEAR : palette.findIndex((p) => p[0] === r && p[1] === g && p[2] === b)
    }
    parts.push(
      Buffer.from([0x21, 0xf9, 0x04, (2 << 2) | 1, ...u16(f.delay), CLEAR, 0]),
      Buffer.from([0x2c, 0, 0, 0, 0, ...u16(w), ...u16(h), 0]),
      lzw(indices, 2),
    )
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

// ── Figures ────────────────────────────────────────────────────────────────

export type Figure = { type: 'png' | 'gif'; data: Buffer; width: number; height: number }

const still = (c: Canvas, flush: 'top' | 'bottom'): Figure => {
  const { w, h, rgba } = rasterise(c, bounds([c], flush))
  return { type: 'png', data: png(w, h, rgba), width: w / DOT, height: h / DOT }
}

export const hanging = (look: Look): Figure => still(hangingPose(look), 'top')

export const clipboard = (look: Look): Figure => still(clipboardPose(look), 'bottom')

/**
 * Hand up, three quick waves from the shoulder, hand up again; twice, then it rests on the raised
 * hand. Twice, not forever: Outlook for Windows plays a GIF three times and then covers it with a
 * play button, and older Outlook shows only the first frame, which is the raised hand too.
 */
export function waving(look: Look): Figure {
  const up = wavingPose(look, 0)
  const out = wavingPose(look, 22)
  const box = bounds([up, out], 'bottom')
  const [a, b] = [rasterise(up, box), rasterise(out, box)]
  const frames = [120, 22, 22, 22, 22, 22, 120].map((delay, i) => ({ rgba: (i % 2 ? b : a).rgba, delay }))
  return { type: 'gif', data: gif(a.w, a.h, frames, 1), width: a.w / DOT, height: a.h / DOT }
}
