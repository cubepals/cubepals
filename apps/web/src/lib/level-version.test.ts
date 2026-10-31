// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The release a world was last played on, and its name, read from real `level.dat` files Minecraft saved. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js'
import { levelOf, playedOn, versionIn } from './level-version.ts'
import { tarOf } from './world-folder.ts'

const FIXTURES = join(import.meta.dir, '../../../control/src/minecraft/world-fixtures')
const level = (world: string) => new Blob([readFileSync(join(FIXTURES, world, 'level.dat'))])
const filler = new Blob([new Uint8Array(3000)])

describe('the release a world was last played on', () => {
  test('is read from a picked folder’s tarball, the world’s own level.dat before one beside it', async () => {
    const tar = tarOf([
      { path: 'My World/region/r.0.0.mca', file: filler },
      { path: 'My World/nether/deeper/level.dat', file: level('paper-1.21.11/world_nether') },
      { path: 'My World/level.dat', file: level('vanilla-26.3/world') },
    ])
    expect(await playedOn(tar)).toBe('26.3')
  })

  test('is read from a long, non-ASCII path a tarball names in an extended header', async () => {
    const deep = `Mundo de prueba ñ/${'carpeta/'.repeat(14)}level.dat`
    expect(await playedOn(tarOf([{ path: deep, file: level('vanilla-1.21.11/world') }]))).toBe('1.21.11')
  })

  test('is read from a zip', async () => {
    const zip = new ZipWriter(new BlobWriter('application/zip'))
    await zip.add('world/region/r.0.0.mca', new BlobReader(filler))
    await zip.add('world/level.dat', new BlobReader(level('paper-26.3/world')))
    expect(await playedOn(await zip.close())).toBe('26.3')
  })

  test('comes with the name the world has in Minecraft, read from the same level.dat', async () => {
    const tar = tarOf([{ path: 'My World/level.dat', file: level('vanilla-26.3/world') }])
    expect(await levelOf(tar)).toEqual({ gameVersion: '26.3', name: 'world' })
    expect(await levelOf(new Blob(['not a world']))).toEqual({ gameVersion: null, name: null })
  })

  test('is unknown for a file it can’t read', async () => {
    expect(await playedOn(new Blob(['not a world']))).toBeNull()
    expect(await playedOn(tarOf([{ path: 'notes.txt', file: filler }]))).toBeNull()
    expect(versionIn(new Uint8Array([8, 0, 0]))).toBeNull()
  })
})
