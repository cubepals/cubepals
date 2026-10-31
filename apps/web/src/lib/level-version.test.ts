// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a world says of itself (the release, its name, and the server types that opened it),
 * read from real `level.dat` files Minecraft saved: the servers' in `world-fixtures/`, and a
 * single-player world Fabric opened in `player-fixtures/26.3/`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js'
import { dataIn, levelOf, playedOn, versionIn } from './level-version.ts'
import { tarOf } from './world-folder.ts'

const MINECRAFT = join(import.meta.dir, '../../../control/src/minecraft')
const FIXTURES = join(MINECRAFT, 'world-fixtures')
const level = (world: string) => new Blob([readFileSync(join(FIXTURES, world, 'level.dat'))])
/** A single-player world Minecraft 26.3 saved with Fabric Loader, its `ServerBrands` `["fabric"]`. */
const FABRIC = join(MINECRAFT, 'player-fixtures/26.3/level.dat')
const gunzipped = (path: string) => new Uint8Array(Bun.gunzipSync(readFileSync(path)))
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

  test('is unknown for a file it can’t read', async () => {
    expect(await playedOn(new Blob(['not a world']))).toBeNull()
    expect(await playedOn(tarOf([{ path: 'notes.txt', file: filler }]))).toBeNull()
    expect(versionIn(new Uint8Array([8, 0, 0]))).toBeNull()
  })
})

describe('the name a world has in Minecraft', () => {
  test('is read from the same level.dat', async () => {
    const tar = tarOf([{ path: 'My World/level.dat', file: level('vanilla-26.3/world') }])
    expect(await levelOf(tar)).toEqual({ gameVersion: '26.3', name: 'world', moddedWith: [] })
  })
})

describe('the server types a world was opened with', () => {
  test('a world Fabric opened says so, picked as a folder or zipped', async () => {
    const tar = tarOf([
      { path: 'Life/region/r.0.0.mca', file: filler },
      { path: 'Life/level.dat', file: new Blob([readFileSync(FABRIC)]) },
    ])
    expect(await levelOf(tar)).toMatchObject({ gameVersion: '26.3', moddedWith: ['fabric'] })
    const zip = new ZipWriter(new BlobWriter('application/zip'))
    await zip.add('saves/Life/level.dat', new BlobReader(new Blob([readFileSync(FABRIC)])))
    expect(await levelOf(await zip.close())).toMatchObject({ gameVersion: '26.3', moddedWith: ['fabric'] })
  })

  test('Paper and Mojang’s own server add no blocks or items, so name no mods', async () => {
    expect(dataIn(gunzipped(join(FIXTURES, 'paper-26.3/world/level.dat')))).toMatchObject({
      version: '26.3',
      brands: ['Paper'],
    })
    expect(await levelOf(tarOf([{ path: 'world/level.dat', file: level('paper-26.3/world') }]))).toMatchObject({
      gameVersion: '26.3',
      moddedWith: [],
    })
    expect(
      (await levelOf(tarOf([{ path: 'w/level.dat', file: level('vanilla-1.21.11/world') }])))?.moddedWith,
    ).toEqual([])
  })

  test('is unknown for a file it can’t read', async () => {
    expect(await levelOf(new Blob(['not a world']))).toEqual({ gameVersion: null, name: null, moddedWith: [] })
  })
})
