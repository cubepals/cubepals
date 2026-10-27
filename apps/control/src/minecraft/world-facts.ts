// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a world's own files say about it, decoded: its `level.dat`, its generation settings (in
 * `level.dat` before 26.1, in a file of their own from then: `world-layout.ts` says where), and
 * the `server.properties` of the server it came from, where it came from one. Read from worlds
 * real servers and games saved: Minecraft 1.20.1 to 26.3, Paper and Fabric (`world-fixtures/`).
 */
import { oneLine } from '@blockly/contracts/plain-text'
import { record, text } from './plain-data.ts'
import { LEVEL_TYPES, type LevelType } from './worlds.ts'

/** A world's facts, as an import uses them. */
export interface WorldFacts {
  /** What its player called it (`LevelName`), or null where it says nothing. */
  name: string | null
  /** The release that last saved it. */
  gameVersion: string
  seed: string | null
  levelType: LevelType
  hardcore: boolean
  /** The server types that have opened it, lowercase: `vanilla`, `paper`, `fabric`… */
  brands: string[]
  /** It holds its single-player host's own data (`Data.Player`), which a server never reads. */
  hostPlayer: boolean
}

/** Server types that run plain Minecraft's blocks and items, whatever they add besides. */
const PLAIN_BRANDS = new Set(['vanilla', 'paper', 'spigot', 'craftbukkit', 'bukkit', 'purpur', 'folia'])

/** The server types a world was opened with that add blocks and items of their own, if any. */
export const moddedBrands = (facts: Pick<WorldFacts, 'brands'>): string[] =>
  facts.brands.filter((brand) => !PLAIN_BRANDS.has(brand))

/**
 * A world's facts, or why it can't be brought: a world from before 1.9 names no release. `genSettings`
 * is the decoded `world_gen_settings.dat` where the world has one.
 */
export function worldFacts(
  levelDat: unknown,
  genSettings: unknown,
  properties: Readonly<Record<string, string>> | null,
): WorldFacts | { refused: string } {
  const data = record(record(levelDat).Data)
  const gameVersion = text(record(data.Version).Name)
  if (!gameVersion) return { refused: 'This world is from before Minecraft 1.9, too old to open here.' }
  const settings = Object.keys(record(data.WorldGenSettings)).length
    ? record(data.WorldGenSettings)
    : record(record(genSettings).data)
  const name = oneLine(text(data.LevelName) ?? '').trim()
  return {
    name: name || null,
    gameVersion,
    seed:
      seedOf(settings.seed ?? data.RandomSeed) ?? (oneLine(properties?.['level-seed'] ?? '').trim() || null),
    levelType: levelTypeOf(settings) ?? levelTypeNamed(properties?.['level-type']),
    hardcore:
      flag(data.hardcore ?? record(data.difficulty_settings).hardcore) ??
      properties?.hardcore?.trim() === 'true',
    brands: (Array.isArray(data.ServerBrands) ? data.ServerBrands : [])
      .map((brand) => text(brand)?.trim().toLowerCase())
      .filter((brand): brand is string => !!brand),
    hostPlayer: Object.keys(record(data.Player)).length > 0,
  }
}

/** A long as prismarine-nbt simplifies one, `[high, low]`, as the decimal Minecraft prints. */
function seedOf(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (!Array.isArray(value) || value.length !== 2) return null
  const [high, low] = value
  if (typeof high !== 'number' || typeof low !== 'number') return null
  return BigInt.asIntN(64, (BigInt(high) << 32n) | BigInt(low >>> 0)).toString()
}

/** A byte the game wrote as true or false; null where there is none. */
function flag(value: unknown): boolean | null {
  return typeof value === 'number' ? value !== 0 : null
}

/** The type the overworld generates as, from its generator; null where it says nothing Blockly offers. */
function levelTypeOf(settings: Record<string, unknown>): LevelType | null {
  const generator = record(record(record(settings.dimensions)['minecraft:overworld']).generator)
  const type = text(generator.type)
  if (type === undefined) return null
  if (type === 'minecraft:flat') return 'minecraft:flat'
  const preset = text(generator.settings)
  if (preset === 'minecraft:large_biomes') return 'minecraft:large_biomes'
  if (preset === 'minecraft:amplified') return 'minecraft:amplified'
  return 'minecraft:normal'
}

/** Older servers wrote `DEFAULT`, `largeBiomes` and friends; anything unknown generates as normal. */
export function levelTypeNamed(value: string | undefined): LevelType {
  const key = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
  const named = LEVEL_TYPES.find((t) => t === `minecraft:${key}`)
  if (named) return named
  if (key === 'largebiomes') return 'minecraft:large_biomes'
  return 'minecraft:normal'
}
