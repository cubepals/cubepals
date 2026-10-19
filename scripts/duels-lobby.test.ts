// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Duels lobby's structures, as `duels-lobby.ts` builds them and a Duels server is given them:
 * each one the control plane carries is the file kept here, read the way the game reads a
 * structure, as large as its map's box, with no player's likeness in it, nothing that falls as it
 * is placed, and nothing a player could take from it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import nbt from 'prismarine-nbt'
import { DUELS_STRUCTURES, STRUCTURES_DIR } from '../apps/control/src/app/setups/duels-structures.ts'
import { TEMPLATES } from '../apps/control/src/app/setups/templates.ts'
import { DUELS_MAPS, WAITING_DATAPACK } from '../apps/control/src/minecraft/duels-waiting/maps.ts'
import { MAPS_1_21_11 } from '../apps/control/src/minecraft/map-art.ts'

/** A map's structure as the game reads it: gzipped NBT. */
const read = (bytes: Buffer) => nbt.simplify(nbt.parseUncompressed(gunzipSync(bytes)))

describe('the Duels lobby’s structures', () => {
  test('each map’s is carried in the waiting datapack, as the file kept here', () => {
    for (const map of DUELS_MAPS) {
      const carried = DUELS_STRUCTURES.find(
        (file) => file.path === `${WAITING_DATAPACK}/data/cubepals/structure/${map.key}.nbt`,
      )
      expect(carried?.encoding).toBe('base64')
      expect(
        Buffer.from(carried?.content ?? '', 'base64').equals(readFileSync(`${STRUCTURES_DIR}${map.key}.nbt`)),
      ).toBe(true)
    }
    const duels = TEMPLATES.find((template) => template.key === 'duels')
    for (const file of DUELS_STRUCTURES) expect(duels?.setup.files).toContainEqual(file)
  })

  test('each is as large as its map’s box, in the release Duels runs, with no entities', () => {
    for (const map of DUELS_MAPS) {
      const root = read(readFileSync(`${STRUCTURES_DIR}${map.key}.nbt`))
      expect(root.size).toEqual(map.to.map((n, i) => n - (map.from[i] ?? 0) + 1))
      expect(root.DataVersion).toBe(MAPS_1_21_11.dataVersion)
      expect(root.entities).toEqual([])
      for (const { pos } of root.blocks as { pos: number[] }[])
        pos.forEach((n, i) => {
          expect(n).toBeGreaterThanOrEqual(0)
          expect(n).toBeLessThan(root.size[i])
        })
    }
  })

  test('no player’s likeness, nothing that falls, and nothing to take', () => {
    for (const map of DUELS_MAPS) {
      const root = read(readFileSync(`${STRUCTURES_DIR}${map.key}.nbt`))
      const names = (root.palette as { Name: string }[]).map((entry) => entry.Name)
      expect(names.filter((name) => /player_(wall_)?head|concrete_powder/.test(name))).toEqual([])
      for (const block of root.blocks as { nbt?: Record<string, unknown> }[]) {
        expect(block.nbt?.Items).toBeUndefined()
        expect(block.nbt?.profile).toBeUndefined()
      }
    }
  })
})
