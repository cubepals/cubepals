// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Duels lobby's maps as files of its waiting datapack: each map's structure, as
 * `scripts/duels-lobby.ts` builds it and this repository keeps it (`apps/control/assets/duels-lobby/`,
 * under each map's own licence). Read once, as the control plane starts, and carried beside the
 * datapack's own files (`minecraft/duels-waiting.ts`), which places them. Not where a map sits or
 * who made it (`minecraft/duels-waiting/maps.ts`).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { CarriedFile } from '../../domain/revision/carried.ts'
import { DUELS_MAPS, NS, WAITING_DATAPACK } from '../../minecraft/duels-waiting/maps.ts'

/** Where the structures are kept in this repository, under their maps' licences (`REUSE.toml`). */
export const STRUCTURES_DIR = fileURLToPath(new URL('../../../assets/duels-lobby/', import.meta.url))

/**
 * Each map's structure file by its SHA-256: the datapack carries these bytes and no others, so a
 * rebuilt structure is a change made on purpose.
 */
const STRUCTURE_SHA256: Readonly<Record<string, string>> = {
  ice: 'c4adca2faf8284d7767300ee66b06f16eb361206c12f4d01e9ea7d8f5bd79ce6',
  debris: '18c32900bd91fab0dee9e5a087f8f0fe4af939a135d12baff148726d637cbcc5',
  cramped: '8107743fa2ecb5369a1b7d632d9624d54733bd6af2e6404fe3e333b2c9448588',
}

/** A map's structure, by its key: its bytes, checked against the SHA-256 pinned here. */
function structure(key: string): Buffer {
  const bytes = readFileSync(`${STRUCTURES_DIR}${key}.nbt`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== STRUCTURE_SHA256[key])
    throw new Error(`The Duels structure ${key}.nbt is not the one pinned (its SHA-256 is ${sha256})`)
  return bytes
}

/** The structures, gzipped as the game reads one, as files of the datapack. */
export const DUELS_STRUCTURES: readonly CarriedFile[] = DUELS_MAPS.map(
  ({ key }): CarriedFile => ({
    path: `${WAITING_DATAPACK}/data/${NS}/structure/${key}.nbt`,
    content: structure(key).toString('base64'),
    encoding: 'base64',
  }),
)
