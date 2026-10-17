// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * That a sign's map art is the mark, crisp: two colours, the mark's own area, circles that are
 * round rather than stepped in blocks, and each map a file the game reads as its own (checked in a
 * 26.2 and a 1.21.11 client, which drew a map written this way in an item frame).
 */
import { describe, expect, test } from 'bun:test'
import { markAt } from './brand-art.ts'
import { artFiles, artMaps, MAP_PIXELS, MAPS_1_21_11, MAPS_26_2, mapFile } from './map-art.ts'

const ART = { side: 4, firstId: 9200 }

/** The art's pixels as one picture, row by row, each true where it is Ink. */
function picture(side: number): boolean[][] {
  const maps = artMaps({ side, firstId: 0 })
  const colours = new Set(maps.flatMap((map) => [...map]))
  // Ink is black at its darkest shade, the larger of the two numbers (`map-art.ts`).
  const ink = Math.max(...colours)
  return Array.from({ length: side * MAP_PIXELS }, (_, y) =>
    Array.from({ length: side * MAP_PIXELS }, (_, x) => {
      const map = maps[Math.floor(y / MAP_PIXELS) * side + Math.floor(x / MAP_PIXELS)]
      return map?.[(y % MAP_PIXELS) * MAP_PIXELS + (x % MAP_PIXELS)] === ink
    }),
  )
}

describe('a sign’s mark as map art', () => {
  test('each map is a map’s file: its data version, locked, and its colours, uncompressed', () => {
    const file = mapFile(new Uint8Array(MAP_PIXELS * MAP_PIXELS), 4903)
    const text = new TextDecoder('latin1').decode(file)
    expect([...file.slice(0, 3)]).toEqual([10, 0, 0])
    for (const name of ['DataVersion', 'dimension', 'minecraft:overworld', 'locked', 'colors'])
      expect(text).toContain(name)
    expect(file.length).toBeGreaterThan(MAP_PIXELS * MAP_PIXELS)
    expect([...file.slice(-2)]).toEqual([0, 0])
  })

  test('each sign carries a map to each block of it, where its release keeps maps', () => {
    expect(artFiles(ART, MAPS_26_2).map((file) => file.path)).toContain(
      '{{blockly.level}}/data/minecraft/maps/9215.dat',
    )
    expect(artFiles(ART, MAPS_1_21_11).map((file) => file.path)).toContain(
      '{{blockly.level}}/data/map_9200.dat',
    )
    expect(artFiles(ART, MAPS_26_2).every((file) => file.encoding === 'base64')).toBe(true)
    expect(artFiles(ART, MAPS_26_2)).toHaveLength(16)
  })

  test('two colours, Ink and Paper, and as much Ink as the mark has, its clear space round it', () => {
    expect(new Set(artMaps(ART).flatMap((map) => [...map])).size).toBe(2)
    const pixels = picture(4)
    const inked = pixels.flat().filter(Boolean).length / pixels.flat().length
    // The mark's own share of its square, sampled finely, in the middle two thirds of the sign.
    let inMark = 0
    for (let v = 0; v < 600; v++)
      for (let u = 0; u < 600; u++) if (markAt((u + 0.5) / 600, (v + 0.5) / 600)) inMark++
    expect(Math.abs(inked - (inMark / 360000) * (2 / 3) ** 2)).toBeLessThan(0.002)
  })

  test('its circles are round: their rows widen a pixel or two at a time, not a block at a time', () => {
    const pixels = picture(4)
    // The circle at the mark's top right, its rows from its top to its middle.
    const widths = new Set<number>()
    const [left, top, size] = [
      Math.round(512 / 6 + 512 * (2 / 3) * 0.5),
      Math.round(512 / 6),
      Math.round((512 * 2) / 3 / 2),
    ]
    for (let y = top; y < top + size / 2; y++)
      widths.add(pixels[y]?.slice(left, left + size).filter(Boolean).length ?? 0)
    expect(widths.size).toBeGreaterThan(40)
  })
})
