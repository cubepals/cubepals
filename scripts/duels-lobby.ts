// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the Duels lobby's structures from the published maps it is made of (`DUELS_MAPS`): the
 * files the waiting datapack carries and places beside the void world's platform. Run it again
 * only when a map, its box or its look changes:
 *
 *     JAVA=/path/to/java21 bun scripts/duels-lobby.ts
 *
 * 1. Each map's folder is fetched from its repository at the pinned commit, and converted by
 *    Chunker to Java 1.21.11, the release Duels runs (`lib/published-maps.ts`).
 * 2. The blocks in the map's box are read, with their states and block entities, and given
 *    Cubepals' look (`lib/duels-look.ts`); a sign or banner keeps what it says and shows, and any
 *    other block entity, a skull or a decorative furnace, is placed as the game makes it.
 * 3. Each is written as a structure, gzipped as the game reads one, to
 *    `apps/control/assets/duels-lobby/<key>.nbt`, and its SHA-256 printed for `STRUCTURE_SHA256`.
 *
 * Everything fetched is kept under `local/duels-lobby/`, so a second run reuses it.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import nbt from 'prismarine-nbt'
import { DUELS_MAPS, DUELS_SOURCES } from '../apps/control/src/minecraft/duels-waiting/maps.ts'
import { MAPS_1_21_11 } from '../apps/control/src/minecraft/map-art.ts'
import type { PublishedMap } from '../apps/control/src/minecraft/map-credits.ts'
import { looked } from './lib/duels-look.ts'
import { chunker, convert, fetchFolders } from './lib/published-maps.ts'
import { type Entity, statesIn } from './lib/region-blocks.ts'

const WORK = resolve('local/duels-lobby')
/** Where the structures are kept, as the control plane reads them (`app/setups/duels-structures.ts`). */
const STRUCTURES_DIR = resolve('apps/control/assets/duels-lobby')
const JAVA = process.env.JAVA ?? 'java'
const say = (line: string) => process.stdout.write(`${line}\n`)

/** What a block entity keeps in a structure: what it says and shows, not where it was or what it holds. */
const LEFT_BEHIND = new Set(['x', 'y', 'z', 'keepPacked', 'Items', 'LootTable', 'LootTableSeed'])

/**
 * Block entities whose data is what they say and show: signs and banners. Any other, a furnace or a
 * hopper standing as a decoration, is placed as the game makes it, empty, so its structure is smaller.
 */
const SHOWN = /sign|banner/

const int = (value: number) => ({ type: 'int' as const, value })
const ints = (values: number[]) => ({ type: 'list' as const, value: { type: 'int' as const, value: values } })

/** A map's blocks as a structure: its palette, and each block by its place from the box's first corner. */
function structure(map: PublishedMap, regionDir: string): Buffer {
  const states = statesIn(regionDir, map.from, map.to)
  const palette: { Name: string; Properties?: Record<string, string> }[] = []
  const index = new Map<string, number>()
  const blocks: Record<string, unknown>[] = []
  const at = (key: string) => key.split(' ').map(Number) as [number, number, number]
  const ordered = [...states].sort(([a], [b]) => {
    const [ax, ay, az] = at(a)
    const [bx, by, bz] = at(b)
    return ay - by || az - bz || ax - bx
  })
  for (const [key, { state, entity }] of ordered) {
    const place = at(key)
    const look = looked(map.key, state.Name, place)
    if (look === null) continue
    const entry = {
      Name: look.name,
      ...(state.Properties === undefined ? {} : { Properties: state.Properties }),
    }
    const id = JSON.stringify(entry)
    if (!index.has(id)) {
      index.set(id, palette.length)
      palette.push(entry)
    }
    const kept: Entity | undefined =
      entity === undefined || look.skull || !SHOWN.test(look.name)
        ? undefined
        : Object.fromEntries(Object.entries(entity).filter(([name]) => !LEFT_BEHIND.has(name)))
    blocks.push({
      state: int(index.get(id) ?? 0),
      pos: ints(place.map((n, i) => n - (map.from[i] ?? 0))),
      ...(kept === undefined ? {} : { nbt: { type: 'compound', value: kept } }),
    })
  }
  const root = {
    type: 'compound' as const,
    name: '',
    value: {
      DataVersion: int(MAPS_1_21_11.dataVersion),
      size: ints(map.to.map((n, i) => n - (map.from[i] ?? 0) + 1)),
      palette: {
        type: 'list',
        value: {
          type: 'compound',
          value: palette.map(({ Name, Properties }) => ({
            Name: { type: 'string', value: Name },
            ...(Properties === undefined
              ? {}
              : {
                  Properties: {
                    type: 'compound',
                    value: Object.fromEntries(
                      Object.entries(Properties).map(([k, v]) => [k, { type: 'string', value: v }]),
                    ),
                  },
                }),
          })),
        },
      },
      blocks: { type: 'list', value: { type: 'compound', value: blocks } },
      entities: { type: 'list', value: { type: 'end', value: [] } },
    },
  } as unknown as nbt.NBT
  say(`${map.title}: ${blocks.length} blocks, ${palette.length} kinds`)
  return gzipSync(nbt.writeUncompressed(root), { level: 9 })
}

mkdirSync(WORK, { recursive: true })
mkdirSync(STRUCTURES_DIR, { recursive: true })
const jar = chunker(WORK)
for (const map of DUELS_MAPS) {
  const source = DUELS_SOURCES[map.key]
  if (source === undefined) throw new Error(`No source for the Duels map ${map.key}`)
  const src = join(fetchFolders(WORK, source.repo, source.commit, [source.path]), source.path)
  const world = convert(JAVA, jar, src, 'JAVA_1_21_11', join(WORK, 'java', map.key))
  const bytes = structure(map, join(world, 'region'))
  writeFileSync(join(STRUCTURES_DIR, `${map.key}.nbt`), bytes)
  say(`  ${map.key}.nbt: ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}`)
}
