// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The blocks of a saved world, read from its region files the way the game writes them (Anvil):
 * each region's table of where its chunks are, each chunk's NBT, zlib'd, and each section's palette
 * with the packed indices into it, and the block entities each chunk keeps beside its blocks. Read
 * only; nothing here writes a world. Not entities, which a world keeps apart from its blocks.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import nbt from 'prismarine-nbt'

type Block = readonly [number, number, number]

/** A block as a section's palette has it: its name and, for a block that has any, its properties. */
interface BlockState {
  Name: string
  Properties?: Record<string, string>
}

interface Section {
  y: number
  palette: BlockState[]
  data: bigint[]
}

interface Chunk {
  sections: Section[]
  /** Its block entities, as the game wrote them (unsimplified NBT), by `x y z`. */
  entities: Map<string, Entity>
}

/** A block entity's fields, unsimplified, as prismarine-nbt reads a compound. */
export type Entity = nbt.Compound['value']

/** A long as prismarine-nbt hands it, its high and low halves, as one unsigned 64-bit number. */
const long = ([high, low]: [number, number]): bigint =>
  BigInt.asUintN(64, (BigInt(high) << 32n) | BigInt(low >>> 0))

/** Every chunk in one region file, by the chunk's x and z within the world. */
function readRegion(file: string): Map<string, Chunk> {
  const chunks = new Map<string, Chunk>()
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
    const raw = nbt.parseUncompressed(inflateSync(bytes.subarray(offset + 5, offset + 4 + length)))
    const root = nbt.simplify(raw)
    const sections: Section[] = (root.sections ?? []).map(
      (section: { Y: number; block_states?: { palette: BlockState[]; data?: [number, number][] } }) => ({
        y: section.Y,
        palette: section.block_states?.palette ?? [],
        data: (section.block_states?.data ?? []).map(long),
      }),
    )
    const entities = new Map<string, Entity>()
    const listed = raw.value.block_entities as nbt.List<nbt.TagType.Compound> | undefined
    for (const entity of (listed?.value.value ?? []) as Entity[]) {
      const at = (name: string) => (entity[name] as nbt.Int | undefined)?.value ?? 0
      entities.set(`${at('x')} ${at('y')} ${at('z')}`, entity)
    }
    chunks.set(`${root.xPos} ${root.zPos}`, { sections, entities })
  }
  return chunks
}

/** The block at a place in a section: its index packed into longs, none crossing from one to the next. */
function blockIn(section: Section, x: number, y: number, z: number): BlockState {
  if (section.palette.length <= 1) return section.palette[0] ?? AIR_STATE
  const bits = Math.max(4, Math.ceil(Math.log2(section.palette.length)))
  const perLong = Math.floor(64 / bits)
  const index = (y * 16 + z) * 16 + x
  const word = section.data[Math.floor(index / perLong)] ?? 0n
  const entry = Number((word >> BigInt((index % perLong) * bits)) & ((1n << BigInt(bits)) - 1n))
  return section.palette[entry] ?? AIR_STATE
}

const AIR_STATE: BlockState = { Name: 'minecraft:air' }

/** Air of each kind, as the game names it: what a box holds where it holds nothing. */
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])

/** A block that isn't air, with its block entity where it has one. */
export interface PlacedState {
  state: BlockState
  entity?: Entity
}

/**
 * Every block in a box that isn't air, by `x y z`, both corners included, read from the folder
 * that holds a dimension's region files.
 */
export function statesIn(regionDir: string, from: Block, to: Block): Map<string, PlacedState> {
  const regions = new Map<string, Map<string, Chunk>>()
  /** The chunk a column is in, reading its region the first time. */
  const chunkAt = (x: number, z: number): Chunk | undefined => {
    const name = `r.${x >> 9}.${z >> 9}.mca`
    const region = regions.get(name) ?? readRegion(join(regionDir, name))
    regions.set(name, region)
    return region.get(`${x >> 4} ${z >> 4}`)
  }
  const found = new Map<string, PlacedState>()
  for (let x = from[0]; x <= to[0]; x++)
    for (let z = from[2]; z <= to[2]; z++) {
      const chunk = chunkAt(x, z)
      if (chunk === undefined) continue
      for (let y = from[1]; y <= to[1]; y++) {
        const placed = placedAt(chunk, x, y, z)
        if (placed !== null) found.set(`${x} ${y} ${z}`, placed)
      }
    }
  return found
}

/** The block at a place in a chunk, with its block entity, or null for air. */
function placedAt(chunk: Chunk, x: number, y: number, z: number): PlacedState | null {
  const section = chunk.sections.find((s) => s.y === y >> 4)
  const state = section === undefined ? AIR_STATE : blockIn(section, x & 15, y & 15, z & 15)
  if (AIR.has(state.Name)) return null
  const entity = chunk.entities.get(`${x} ${y} ${z}`)
  return entity === undefined ? { state } : { state, entity }
}

/**
 * Every block in a box of a world's overworld that isn't air, by `x y z`, both corners included:
 * `world` is the folder `level.dat` is in.
 */
export function blocksIn(world: string, from: Block, to: Block): Map<string, string> {
  const states = statesIn(join(world, 'dimensions', 'minecraft', 'overworld', 'region'), from, to)
  return new Map([...states].map(([at, { state }]) => [at, state.Name]))
}
