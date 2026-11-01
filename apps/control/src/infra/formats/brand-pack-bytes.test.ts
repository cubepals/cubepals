// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The application builds the actual archive inside each case, so a broken build fails the case. */
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { PNG } from 'pngjs'
import { brandPackPath, buildBrandPack } from '../../app/artifacts/brand-pack.ts'
import { BRAND_PACK } from '../../minecraft/brand-pack.ts'
import { LibraryFileFormats } from './file-formats.ts'

for (const origin of ['https://cubepals.test', 'https://cubepals.test/'])
  test(`the resource pack retains its files, pixels and content address from ${origin}`, () => {
    const formats = new LibraryFileFormats()
    const pack = buildBrandPack(formats, origin)
    const files = unzipSync(pack.bytes)
    expect(Object.keys(files)).toEqual(BRAND_PACK.map((file) => file.path))
    for (const file of BRAND_PACK) {
      const bytes = files[file.path]
      if (!bytes) throw new Error(`The archive lost ${file.path}`)
      if ('json' in file) {
        const text = strFromU8(bytes)
        expect(JSON.parse(text)).toEqual(file.json)
        // Readable JSON and a final newline are part of the pack's stable byte representation.
        expect(text).toBe(`${JSON.stringify(file.json, null, 2)}\n`)
      } else {
        const picture = PNG.sync.read(Buffer.from(bytes))
        expect([picture.width, picture.height]).toEqual([file.picture.width, file.picture.height])
        expect(picture.data).toEqual(Buffer.from(file.picture.rgba))
      }
    }
    expect(pack.sha1).toBe(createHash('sha1').update(pack.bytes).digest('hex'))
    expect(pack.url).toBe(`https://cubepals.test/api/public/pack/${pack.sha1}.zip`)
    expect(brandPackPath(pack.sha1)).toBe(new URL(pack.url).pathname)
    expect(buildBrandPack(formats, origin)).toEqual(pack)
  })
