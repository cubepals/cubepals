// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' mark as map art: Ink on a square of Paper, with the brand's clear space round it
 * (`brand/README.md`), drawn from its own shapes (`brand-art.ts`) a hundred and twenty-eight pixels
 * to a block, the most a map holds, so its circles stay round however near a player stands. Each
 * block of a sign is one map in an item frame (`marquee.ts`). A map is kept as the game keeps it,
 * a file in the world's data, which the server reads when a frame first shows it; it is carried to
 * a server as any of Cubepals' files is (`carried.ts`), uncompressed, which the game reads as well
 * as gzipped (checked on 26.2 and 1.21.11). Not where signs are.
 *
 * A map draws in the game's map colours alone, each a base colour at one of four shades. Ink is
 * black at its darkest shade, exactly `#0D0D0D`; Paper is quartz at its brightest, `#FFFCF5`, the
 * nearest a map has to `#F8F7F5`.
 */
import { type CarriedFile, RUNNING_LEVEL } from '../domain/revision/carried.ts'
import { markPixel } from './brand-art.ts'

/** A map's side, in pixels. */
export const MAP_PIXELS = 128

/**
 * A map colour as a map's colours hold it: the base colour's id times four, and its shade (the
 * game's `MapColor` and `MapColor.Brightness`: quartz is 14 and black 29; shade 2 is the colour
 * as it is, 3 its darkest, 135/255 of it).
 */
const mapColour = (id: number, shade: 0 | 1 | 2 | 3) => id * 4 + shade
const PAPER_MAP = mapColour(14, 2)
const INK_MAP = mapColour(29, 3)

/** The brand's clear space round the mark: a quarter of its height, on every side. */
const CLEAR = 0.25

/** A sign's art: its side in blocks, and the id of its top left map, the rest following row by row. */
export interface MapArt {
  side: number
  firstId: number
}

/** The id of the map at a block of a sign's art, across and down from its top left. */
export const mapId = (art: MapArt, across: number, down: number): number =>
  art.firstId + down * art.side + across

/** Each map of a sign's art, row by row, as its colours: the mark in Ink, centred, on Paper. */
export function artMaps(art: MapArt): Uint8Array[] {
  const pixels = art.side * MAP_PIXELS
  const mark = pixels / (1 + 2 * CLEAR)
  const margin = (pixels - mark) / 2
  const ink = (x: number, y: number) => markPixel(x - margin, y - margin, mark)
  return Array.from({ length: art.side * art.side }, (_, i) => {
    const [across, down] = [i % art.side, Math.floor(i / art.side)]
    const colours = new Uint8Array(MAP_PIXELS * MAP_PIXELS)
    for (let y = 0; y < MAP_PIXELS; y++)
      for (let x = 0; x < MAP_PIXELS; x++)
        colours[y * MAP_PIXELS + x] = ink(across * MAP_PIXELS + x, down * MAP_PIXELS + y)
          ? INK_MAP
          : PAPER_MAP
    return colours
  })
}

/** NBT, uncompressed, as the game writes it: a tag's type, its name, and what it holds, big-endian. */
class Nbt {
  readonly #bytes: number[] = []
  #name(name: string) {
    const utf8 = new TextEncoder().encode(name)
    this.#bytes.push(utf8.length >> 8, utf8.length & 255, ...utf8)
  }
  #int(value: number) {
    this.#bytes.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
  }
  open(name: string) {
    this.#bytes.push(10)
    this.#name(name)
    return this
  }
  close() {
    this.#bytes.push(0)
    return this
  }
  int(name: string, value: number) {
    this.#bytes.push(3)
    this.#name(name)
    this.#int(value)
    return this
  }
  byte(name: string, value: number) {
    this.#bytes.push(1)
    this.#name(name)
    this.#bytes.push(value & 255)
    return this
  }
  string(name: string, value: string) {
    this.#bytes.push(8)
    this.#name(name)
    this.#name(value)
    return this
  }
  bytes(name: string, values: Uint8Array) {
    this.#bytes.push(7)
    this.#name(name)
    this.#int(values.length)
    for (const value of values) this.#bytes.push(value)
    return this
  }
  done = (): Uint8Array => Uint8Array.from(this.#bytes)
}

/**
 * A map's file, as the game keeps it: locked, so nothing the world does draws over it, and centred
 * on nothing, since it shows no land. `dataVersion` is the world's, so the game reads it as its own.
 */
export function mapFile(colours: Uint8Array, dataVersion: number): Uint8Array {
  return new Nbt()
    .open('')
    .int('DataVersion', dataVersion)
    .open('data')
    .string('dimension', 'minecraft:overworld')
    .int('xCenter', 0)
    .int('zCenter', 0)
    .byte('scale', 0)
    .byte('locked', 1)
    .byte('trackingPosition', 0)
    .byte('unlimitedTracking', 0)
    .bytes('colors', colours)
    .close()
    .close()
    .done()
}

/** Where a release keeps a map in a world, and the data version its worlds are written in. */
export interface MapRelease {
  path: (id: number) => string
  dataVersion: number
}

/** 26.2: maps under `data/minecraft/maps/`, data version 4903, as its worlds' `level.dat` says. */
export const MAPS_26_2: MapRelease = {
  path: (id) => `${RUNNING_LEVEL}/data/minecraft/maps/${id}.dat`,
  dataVersion: 4903,
}

/** 1.21.11: maps as `data/map_<id>.dat`, data version 4671, as its worlds' `level.dat` says. */
export const MAPS_1_21_11: MapRelease = {
  path: (id) => `${RUNNING_LEVEL}/data/map_${id}.dat`,
  dataVersion: 4671,
}

/** A sign's maps as files Cubepals carries to a server, each in the running world. */
export function artFiles(art: MapArt, release: MapRelease): CarriedFile[] {
  return artMaps(art).map((colours, i) => ({
    path: release.path(art.firstId + i),
    content: Buffer.from(mapFile(colours, release.dataVersion)).toString('base64'),
    encoding: 'base64',
  }))
}
