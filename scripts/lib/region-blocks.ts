// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The blocks of a saved world, read from its region files the way the game writes them (Anvil):
 * each region's table of where its chunks are, each chunk's NBT, zlib'd, and each section's palette
 * with the packed indices into it. Read only; nothing here writes a world. Not entities, which a
 * world keeps apart from its blocks.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import nbt from 'prismarine-nbt'

type Block = readonly [number, number, number]

interface Section {
  y: number
  palette: string[]
  data: bigint[]
}

/** A long as prismarine-nbt hands it, its high and low halves, as one unsigned 64-bit number. */
const long = ([high, low]: [number, number]): bigint =>
  BigInt.asUintN(64, (BigInt(high) << 32n) | BigInt(low >>> 0))

/** Every chunk's sections in one region file, by the chunk's x and z within the world. */
function readRegion(file: string): Map<string, Section[]> {
  const chunks = new Map<string, Section[]>()
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch {
    return chunks
  }
  for (let slot = 0; slot < 1024; slot++) {
    const location = bytes.readUInt32BE(slot * 4)
    const offset = (location >>> 8) * 4096
    if (offset === 0) continue
    const length = bytes.readUInt32BE(offset)
    if (bytes[offset + 4] !== 2) throw new Error(`${file}: a chunk not zlib'd`)
    const root = nbt.simplify(
      nbt.parseUncompressed(inflateSync(bytes.subarray(offset + 5, offset + 4 + length))),
    )
    const sections: Section[] = (root.sections ?? []).map(
      (section: {
        Y: number
        block_states?: { palette: { Name: string }[]; data?: [number, number][] }
      }) => ({
        y: section.Y,
        palette: (section.block_states?.palette ?? []).map((entry) => entry.Name),
        data: (section.block_states?.data ?? []).map(long),
      }),
    )
    chunks.set(`${root.xPos} ${root.zPos}`, sections)
  }
  return chunks
}

/** The block at a place in a section: its index packed into longs, none crossing from one to the next. */
function blockIn(section: Section, x: number, y: number, z: number): string {
  if (section.palette.length <= 1) return section.palette[0] ?? 'minecraft:air'
  const bits = Math.max(4, Math.ceil(Math.log2(section.palette.length)))
  const perLong = Math.floor(64 / bits)
  const index = (y * 16 + z) * 16 + x
  const word = section.data[Math.floor(index / perLong)] ?? 0n
  const entry = Number((word >> BigInt((index % perLong) * bits)) & ((1n << BigInt(bits)) - 1n))
  return section.palette[entry] ?? 'minecraft:air'
}

/** Air of each kind, as the game names it: what a box holds where it holds nothing. */
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])

/**
 * Every block in a box of a world's overworld that isn't air, by `x y z`, both corners included:
 * `world` is the folder `level.dat` is in.
 */
export function blocksIn(world: string, from: Block, to: Block): Map<string, string> {
  const regions = new Map<string, Map<string, Section[]>>()
  const dir = join(world, 'dimensions', 'minecraft', 'overworld', 'region')
  /** The sections of the chunk a column is in, reading its region the first time. */
  const sectionsAt = (x: number, z: number): Section[] => {
    const name = `r.${x >> 9}.${z >> 9}.mca`
    const region = regions.get(name) ?? readRegion(join(dir, name))
    regions.set(name, region)
    return region.get(`${x >> 4} ${z >> 4}`) ?? []
  }
  const found = new Map<string, string>()
  for (let x = from[0]; x <= to[0]; x++)
    for (let z = from[2]; z <= to[2]; z++) {
      const sections = sectionsAt(x, z)
      for (let y = from[1]; y <= to[1]; y++) {
        const section = sections.find((s) => s.y === y >> 4)
        const block = section === undefined ? 'minecraft:air' : blockIn(section, x & 15, y & 15, z & 15)
        if (!AIR.has(block)) found.set(`${x} ${y} ${z}`, block)
      }
    }
  return found
}
