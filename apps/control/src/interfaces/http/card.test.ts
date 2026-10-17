// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The picture a shared link shows. It is drawn here rather than rendered by anything installed,
 * so what these check is that it is a real PNG of the right size, that what it says changes with
 * the server it is about, and that it says Cubepals: the brand's lockup, and never the codename.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { FONT, LOCKUP_FILE, serverCard } from './card.ts'

describe('link picture', () => {
  const card = (patch: Partial<Parameters<typeof serverCard>[0]> = {}) =>
    serverCard({
      name: 'Sunset Valley',
      awake: true,
      online: 4,
      maxPlayers: 10,
      gameVersion: '26.3',
      serverType: null,
      invited: false,
      ...patch,
    })

  test('is a 1200 by 630 PNG, which is what a preview asks for', () => {
    const png = card()
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // IHDR: length, kind, then width and height.
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND')
  })

  test('a different server is a different picture', () => {
    expect(card().equals(card({ name: 'Nudge World' }))).toBe(false)
    expect(card().equals(card({ awake: false }))).toBe(false)
    expect(card().equals(card({ online: 5 }))).toBe(false)
    expect(card().equals(card({ invited: true }))).toBe(false)
    // The same server twice is the same bytes, so a CDN can cache it.
    expect(card().equals(card())).toBe(true)
  })

  test('a name too long for two lines is cut, and an empty one still draws', () => {
    expect(card({ name: 'A'.repeat(200) }).length).toBeGreaterThan(1000)
    expect(card({ name: '   ' }).length).toBeGreaterThan(1000)
    // Emoji and anything else the font has no shape for never leave a hole.
    expect(card({ name: '🌅 Sunset 🌅' }).length).toBeGreaterThan(1000)
  })

  test('says Cubepals, and never the codename, whatever the server', () => {
    const cards = [
      card(),
      card({ awake: false }),
      card({ invited: true }),
      card({ name: 'The Long Winter Survival Server for Everyone' }),
    ]
    for (const png of cards)
      for (const scale of [4, 5, 8, 11]) expect(says(png, 'BLOCKLY', scale)).toBe(false)
    // The search finds words the card does draw, so the line above can fail.
    expect(says(card({ name: 'Blockly' }), 'BLOCKLY', 11)).toBe(true)
    expect(says(card(), 'PLAYING', 5)).toBe(true)
  })

  test("carries the brand's own lockup, which the control plane's image ships", () => {
    const image = PNG.sync.read(card())
    // The lockup sits bottom left, in Ink: the mark and the word are thousands of its pixels.
    let ink = 0
    for (let y = 476; y < 558; y++)
      for (let x = 72; x < 472; x++) {
        const at = (y * image.width + x) * 4
        if (image.data[at] === 0x0d && image.data[at + 1] === 0x0d && image.data[at + 2] === 0x0d) ink++
      }
    expect(ink).toBeGreaterThan(5000)
    expect(existsSync(LOCKUP_FILE)).toBe(true)
    const dockerfile = readFileSync(fileURLToPath(new URL('../../../Dockerfile', import.meta.url)), 'utf8')
    expect(dockerfile).toContain('COPY brand/png/lockup-horizontal.png brand/png/lockup-horizontal.png')
  })
})

type Cell = [x: number, y: number]

/**
 * Whether the card draws `word` in its own pixel font at `scale`, in any one colour on any other:
 * the picture read back the way it was drawn.
 */
function says(png: Buffer, word: string, scale: number): boolean {
  const image = PNG.sync.read(png)
  const colour = (x: number, y: number) => {
    const at = (y * image.width + x) * 4
    return (
      ((image.data[at] as number) << 16) |
      ((image.data[at + 1] as number) << 8) |
      (image.data[at + 2] as number)
    )
  }
  const { on, off } = cellsOf(word, scale)
  const [firstOn, firstOff] = [on[0] as Cell, off[0] as Cell]
  const drawnAt = (x: number, y: number) => {
    const ink = colour(x + firstOn[0], y + firstOn[1])
    const ground = colour(x + firstOff[0], y + firstOff[1])
    return (
      ink !== ground &&
      on.every(([dx, dy]) => colour(x + dx, y + dy) === ink) &&
      off.every(([dx, dy]) => colour(x + dx, y + dy) === ground)
    )
  }
  for (let y = 0; y + 7 * scale <= image.height; y++)
    for (let x = 0; x + (word.length * 6 - 1) * scale <= image.width; x++) if (drawnAt(x, y)) return true
  return false
}

/** Where each of a word's font pixels starts, split into those drawn and those left blank. */
function cellsOf(word: string, scale: number): { on: Cell[]; off: Cell[] } {
  const on: Cell[] = []
  const off: Cell[] = []
  for (const [index, character] of [...word].entries())
    for (let row = 0; row < 7; row++) {
      const bits = Number.parseInt((FONT[character] as string).slice(row * 2, row * 2 + 2), 16)
      for (let column = 0; column < 5; column++)
        ((bits >> (4 - column)) & 1 ? on : off).push([(index * 6 + column) * scale, row * scale])
    }
  return { on, off }
}
