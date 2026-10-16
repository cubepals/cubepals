// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Uploaded datapacks as Minecraft reads them: the formats each way of writing `pack.mcmeta` covers,
 * against the releases' own table, and which files a datapack holds.
 */
import { describe, expect, test } from 'bun:test'
import {
  datapackFileName,
  datapackFits,
  datapackLayout,
  datapackTitle,
  madeFor,
  packMeta,
  packRoot,
  releasesFor,
} from './datapack-files.ts'

const formatsOf = (pack: Record<string, unknown>) => {
  const read = packMeta({ pack })
  if (read.kind !== 'pack') throw new Error(read.message)
  return read.formats
}

describe('what a datapack declares', () => {
  test('each way of writing its formats covers the releases whose server reads it', () => {
    // 1.21 and 1.21.1 read format 48.
    expect(releasesFor(formatsOf({ pack_format: 48 }))).toEqual(['1.21.1', '1.21'])
    expect(madeFor(releasesFor(formatsOf({ pack_format: 48 })))).toBe('1.21–1.21.1')
    expect(madeFor(releasesFor(formatsOf({ pack_format: 15 })))).toBe('1.20–1.20.1')
    // A range, in either form, covers every release between.
    const ranged = formatsOf({ pack_format: 48, supported_formats: [48, 61] })
    expect(datapackFits(ranged, '1.21.4')).toBe(true)
    expect(datapackFits(ranged, '1.21.5')).toBe(false)
    expect(
      formatsOf({ pack_format: 48, supported_formats: { min_inclusive: 48, max_inclusive: 61 } }),
    ).toEqual(ranged)
    // From 1.21.9 a format has a minor number, and `pack_format` may be left out.
    const minor = formatsOf({ min_format: [94, 1], max_format: 101 })
    expect(datapackFits(minor, '1.21.11')).toBe(true)
    expect(datapackFits(minor, '26.1.2')).toBe(true)
    expect(datapackFits(minor, '1.21.10')).toBe(false)
    expect(datapackFits(formatsOf({ min_format: [94, 2], max_format: [94, 9] }), '1.21.11')).toBe(false)
    // A format no release reads yet fits nothing, and says so.
    expect(madeFor(releasesFor(formatsOf({ pack_format: 9000 })))).toBeNull()
    expect(datapackFits(formatsOf({ pack_format: 48 }), '1.21.2')).toBe(false)
  })

  test('one without formats isn’t a datapack; its name is its description’s first line', () => {
    expect(packMeta({ pack: { description: 'x' } })).toMatchObject({ kind: 'refused' })
    expect(packMeta('not an object')).toMatchObject({ kind: 'refused' })
    const component = packMeta({
      pack: { pack_format: 48, description: [{ text: '§6Castle ' }, { text: 'Siege', extra: ['!'] }] },
    })
    expect(component).toMatchObject({ kind: 'pack', description: 'Castle Siege!' })
    expect(datapackTitle('\n  Castle   Siege \nby Alex', 'castle.zip')).toBe('Castle Siege')
    expect(datapackTitle('', 'castle-siege.zip')).toBe('castle-siege')
    expect(datapackTitle('x'.repeat(80), 'a.zip')).toHaveLength(60)
  })

  test('a zip’s name is kept plain, and only a zip is a datapack', () => {
    expect(datapackFileName('C:\\games\\My Minigame (v2).zip')).toBe('My-Minigame-v2-.zip')
    expect(datapackFileName('mod.jar')).toBeNull()
  })
})

describe('a datapack’s files', () => {
  test('it is at the top, or in the one folder everything is in', () => {
    expect(packRoot(['pack.mcmeta', 'data/x/a.json'])).toBe('')
    expect(packRoot(['Game/pack.mcmeta', 'Game/data/x/a.json', '__MACOSX/Game/._pack.mcmeta'])).toBe('Game/')
    expect(packRoot(['Game/pack.mcmeta', 'Other/data/x/a.json'])).toBeNull()
    expect(packRoot(['data/x/a.json'])).toBeNull()
  })

  test('only pack.mcmeta, pack.png and data are kept; resource-pack files are left out', () => {
    const names = ['pack.mcmeta', 'pack.png', 'data/x/a.json', 'assets/x/t.png', 'v2/data/x/b.json']
    expect(datapackLayout(names, '', ['v2'])).toEqual({
      kind: 'datapack',
      root: '',
      kept: ['pack.mcmeta', 'pack.png', 'data/x/a.json', 'v2/data/x/b.json'],
      repack: true,
      leftOut: true,
    })
    expect(datapackLayout(['pack.mcmeta', 'data/x/a.json'], '', [])).toMatchObject({ repack: false })
    expect(datapackLayout(['pack.mcmeta', 'v2/data/x/b.json'], '', [])).toMatchObject({ kind: 'refused' })
    for (const code of ['data/x/a.jar', 'data/x/A.CLASS', 'data/x/lib.so', 'data/x/more.tar.gz'])
      expect(datapackLayout(['pack.mcmeta', code], '', [])).toMatchObject({
        kind: 'refused',
        message: expect.stringContaining('which is code or another archive'),
      })
  })
})
