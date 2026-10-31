// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a world says of how it was last played, read in the browser before it is sent: its
 * `level.dat`, found in the tarball a picked folder becomes (`world-folder.ts`) or in a zip, and its
 * `Data.Version.Name`, `Data.LevelName` and `Data.ServerBrands`. A tarball is walked header by header and a zip read
 * from its directory, so a world of gigabytes is never read whole. Null where it can't tell: a
 * gzipped tarball, no `level.dat`, or one it can't read. The control plane reads the world again and
 * decides; this only lets the page say early what it will: that the world is from a newer Minecraft,
 * or that it was played with mods, whose instance the page then asks for so they come too.
 *
 * The reader is written here rather than taken from a library: `level.dat` is gzipped NBT, and the
 * NBT readers on npm (prismarine-nbt, which the control plane uses) need Node's Buffer, while this
 * needs three values from it.
 */
import { moddedOf } from '@blockly/contracts/server-brands'

const BLOCK = 512
const decoder = new TextDecoder()

/** What a world's `level.dat` says of it. */
export interface LevelSays {
  /** The release that last saved it, or null where it names none. */
  gameVersion: string | null
  /** The name the world has in Minecraft, or null where it has none. */
  name: string | null
  /**
   * The server types that opened it and add blocks and items of their own (`fabric`, `forge`…), as
   * the control plane names them (`moddedOf`); empty for a world plain Minecraft opened.
   */
  moddedWith: string[]
}

const UNKNOWN: LevelSays = { gameVersion: null, name: null, moddedWith: [] }

/** What a world's file says of it; nothing known where it can't tell. */
export async function levelOf(file: Blob): Promise<LevelSays> {
  try {
    const level = (await levelInTar(file)) ?? (await levelInZip(file))
    if (level === null) return UNKNOWN
    const said = dataIn(
      new Uint8Array(await new Response(level.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
    )
    return { gameVersion: said.version, name: said.name, moddedWith: moddedOf(said.brands) }
  } catch {
    return UNKNOWN
  }
}

/** The release in a world's file, or null where it can't tell. */
export const playedOn = async (file: Blob): Promise<string | null> => (await levelOf(file)).gameVersion

/** The shallowest `level.dat` among names, the world's own rather than one in a world beside it. */
const isLevel = (name: string) => /(^|\/)level\.dat$/.test(name)
const depth = (name: string) => name.split('/').length

/** One ustar header: the file's name, its size, its type, and where its bytes start. */
interface TarEntry {
  name: string
  size: number
  type: string
  body: number
}

const field = (header: string, from: number, to: number) => header.slice(from, to).replace(/\0.*$/s, '')

async function entryAt(file: Blob, at: number): Promise<TarEntry | null> {
  const header = decoder.decode(await file.slice(at, at + BLOCK).arrayBuffer())
  const name = field(header, 0, 100)
  if (name === '') return null
  const size = Number.parseInt(field(header, 124, 136).trim() || '0', 8)
  return { name, size, type: header[156] ?? '', body: at + BLOCK }
}

/** `level.dat` from a POSIX tarball, its headers read one at a time; null for anything else. */
async function levelInTar(file: Blob): Promise<Blob | null> {
  if (decoder.decode(await file.slice(257, 262).arrayBuffer()) !== 'ustar') return null
  let found: { at: number; size: number; name: string } | null = null
  let longName: string | null = null
  for (let entry = await entryAt(file, 0); entry !== null; ) {
    const { name, size, type, body } = entry
    if (type === 'x') {
      const record = decoder.decode(await file.slice(body, body + size).arrayBuffer())
      longName = record.match(/\d+ path=(.*)\n/)?.[1] ?? null
    } else {
      const path = longName ?? name
      longName = null
      if (isLevel(path) && (found === null || depth(path) < depth(found.name)))
        found = { at: body, size, name: path }
    }
    const next = body + Math.ceil(size / BLOCK) * BLOCK
    entry = next + BLOCK <= file.size ? await entryAt(file, next) : null
  }
  return found === null ? null : file.slice(found.at, found.at + found.size)
}

/** `level.dat` from a zip, read from its directory at the end; null for anything else. */
async function levelInZip(file: Blob): Promise<Blob | null> {
  const { BlobReader, BlobWriter, ZipReader } = await import('@zip.js/zip.js')
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false })
  try {
    const levels = (await reader.getEntries()).filter((entry) => !entry.directory && isLevel(entry.filename))
    const level = levels.sort((a, b) => depth(a.filename) - depth(b.filename))[0]
    return level && !level.directory ? await level.getData(new BlobWriter()) : null
  } catch {
    return null
  } finally {
    await reader.close().catch(() => undefined)
  }
}

/** The bytes of NBT's fixed-size tags (byte, short, int, long, float, double). */
const FIXED: Record<number, number> = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8 }
/** The width of one element of NBT's arrays (bytes, ints, longs), whose length comes first. */
const ARRAYS: Record<number, number> = { 7: 1, 11: 4, 12: 8 }
const STRING = 8
const LIST = 9
const COMPOUND = 10

/** NBT read forward, big-endian. */
class Cursor {
  #at = 0
  readonly #view: DataView
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u8(): number {
    return this.#view.getUint8(this.#at++)
  }
  u16(): number {
    const value = this.#view.getUint16(this.#at)
    this.#at += 2
    return value
  }
  i32(): number {
    const value = this.#view.getInt32(this.#at)
    this.#at += 4
    return value
  }
  pass(count: number): void {
    this.#at += count
  }
  string(): string {
    const length = this.u16()
    const value = decoder.decode(this.bytes.subarray(this.#at, this.#at + length))
    this.#at += length
    return value
  }
}

/** Passes over one tag's payload. */
function skip(nbt: Cursor, type: number): void {
  const fixed = FIXED[type]
  const width = ARRAYS[type]
  if (fixed !== undefined) nbt.pass(fixed)
  else if (width !== undefined) nbt.pass(nbt.i32() * width)
  else if (type === STRING) nbt.pass(nbt.u16())
  else if (type === LIST) {
    const inner = nbt.u8()
    for (let count = nbt.i32(); count > 0; count--) skip(nbt, inner)
  } else if (type === COMPOUND) {
    for (let tag = nbt.u8(); tag !== 0; tag = nbt.u8()) {
      nbt.string()
      skip(nbt, tag)
    }
  } else throw new Error(`NBT tag ${type}`)
}

/** In a compound, the string tag `name` holds, passing over the rest; null where it holds none. */
function stringNamed(nbt: Cursor, name: string): string | null {
  let found: string | null = null
  for (let tag = nbt.u8(); tag !== 0; tag = nbt.u8()) {
    if (nbt.string() === name && tag === STRING) found = nbt.string()
    else skip(nbt, tag)
  }
  return found
}

/** A list's strings, or none where it holds another type. */
function strings(nbt: Cursor): string[] {
  const inner = nbt.u8()
  const found: string[] = []
  for (let count = nbt.i32(); count > 0; count--)
    if (inner === STRING) found.push(nbt.string())
    else skip(nbt, inner)
  return found
}

/** What `level.dat` says of how a world was last played. */
interface DataSays {
  version: string | null
  name: string | null
  brands: string[]
}

/** In the `Data` compound, its `Version.Name` and its `ServerBrands`, passing over the rest. */
function readData(nbt: Cursor): DataSays {
  const said: DataSays = { version: null, name: null, brands: [] }
  for (let tag = nbt.u8(); tag !== 0; tag = nbt.u8()) {
    const name = nbt.string()
    if (name === 'Version' && tag === COMPOUND) said.version = stringNamed(nbt, 'Name')
    else if (name === 'ServerBrands' && tag === LIST) said.brands = strings(nbt)
    else if (name === 'LevelName' && tag === STRING) said.name = nbt.string().trim() || null
    else skip(nbt, tag)
  }
  return said
}

/**
 * `Data.Version.Name` and `Data.ServerBrands` from NBT, following only `Data` and passing over the
 * rest: the release that last saved the world, and the server types that have opened it.
 */
export function dataIn(bytes: Uint8Array): DataSays {
  const nbt = new Cursor(bytes)
  if (nbt.u8() !== COMPOUND) return { version: null, name: null, brands: [] }
  nbt.string()
  for (let tag = nbt.u8(); tag !== 0; tag = nbt.u8()) {
    if (nbt.string() === 'Data' && tag === COMPOUND) return readData(nbt)
    skip(nbt, tag)
  }
  return { version: null, name: null, brands: [] }
}

/** `Data.Version.Name` from NBT: the release that last saved the world. */
export const versionIn = (bytes: Uint8Array): string | null => dataIn(bytes).version
