// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' resource pack as the file formats write it (`app/artifacts/brand-pack.ts`): read back
 * with the same libraries, it is the pack's files, its pictures are what was drawn, and its hash
 * is its bytes'.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { PNG } from 'pngjs'
import { brandPackPath, buildBrandPack } from '../../app/artifacts/brand-pack.ts'
import { BRAND_PACK, RESOURCE_FORMATS } from '../../minecraft/brand-pack.ts'
import { LibraryFileFormats } from './file-formats.ts'

describe("Cubepals' resource pack as a zip", () => {
  const formats = new LibraryFileFormats()
  const built = buildBrandPack(formats, 'https://cubepals.test/')
  const files = unzipSync(built.bytes)

  test('it holds every file of the pack at its path, pack.mcmeta at the top', () => {
    expect(Object.keys(files)).toEqual(BRAND_PACK.map((file) => file.path))
    const { pack } = JSON.parse(strFromU8(files['pack.mcmeta'] ?? new Uint8Array())) as {
      pack: { min_format: number; max_format: number; description: string }
    }
    expect(pack).toEqual({
      description: expect.any(String),
      min_format: RESOURCE_FORMATS.min,
      max_format: RESOURCE_FORMATS.max,
    })
  })

  test('its pictures are PNGs the size and pixels they were drawn', () => {
    for (const file of BRAND_PACK)
      if ('picture' in file) {
        const png = PNG.sync.read(Buffer.from(files[file.path] ?? new Uint8Array()))
        expect([png.width, png.height]).toEqual([file.picture.width, file.picture.height])
        expect([...png.data]).toEqual([...file.picture.rgba])
      }
  })

  test('the SHA-1 the server names is of its very bytes, and the same pack always makes the same bytes', () => {
    expect(built.sha1).toBe(createHash('sha1').update(built.bytes).digest('hex'))
    expect(built.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(buildBrandPack(formats, 'https://cubepals.test')).toEqual(built)
  })

  test("its link is on the site's own address, and names its SHA-1", () => {
    expect(built.url).toBe(`https://cubepals.test${brandPackPath(built.sha1)}`)
    expect(built.url).toEndWith(`/api/public/pack/${built.sha1}.zip`)
  })
})
