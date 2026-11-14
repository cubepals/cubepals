// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Which release `bun scripts/compat-pins.ts bump` takes, and what `check` names as newer. */
import { describe, expect, test } from 'bun:test'
import type { CatalogVersion } from '../apps/control/src/domain/mods/catalog.ts'
import { COMPAT_PINS } from '../apps/control/src/minecraft/compat-pins.ts'
import { behind, heldBack, newestInAll } from './compat-pins.ts'

const version = (versionId: string, day: number, over: Partial<CatalogVersion> = {}): CatalogVersion => ({
  versionId,
  projectId: 'p',
  versionLabel: versionId,
  channel: 'release',
  state: 'listed',
  environment: 'server_only',
  loaders: ['paper'],
  gameVersions: [],
  publishedAt: new Date(Date.UTC(2026, 0, day)),
  file: { url: '', sha512: '', sizeBytes: 0, fileName: '' },
  dependencies: [],
  ...over,
})

describe('newestInAll', () => {
  test('takes the newest release that every Minecraft release lists', () => {
    const a = version('a', 1)
    const b = version('b', 2)
    const c = version('c', 3)
    expect(
      newestInAll([
        [a, b, c],
        [a, b],
      ])?.versionId,
    ).toBe('b')
  })

  test('passes over a beta and a release taken down', () => {
    const lists = [
      [version('a', 1), version('b', 2, { channel: 'beta' }), version('c', 3, { state: 'archived' })],
    ]
    expect(newestInAll(lists)?.versionId).toBe('a')
  })

  test('is null where no release runs on them all', () => {
    expect(newestInAll([[version('a', 1)], [version('b', 2)]])).toBeNull()
  })
})

describe('behind', () => {
  test('says nothing for the pins themselves', () => {
    expect(behind(COMPAT_PINS, COMPAT_PINS)).toEqual([])
  })

  test('names each plugin a newer release would replace, and Floodgate by build', () => {
    const [first, ...rest] = COMPAT_PINS.plugins
    if (first === undefined || COMPAT_PINS.floodgate === null) throw new Error('no pins')
    const newer = {
      plugins: [{ ...first, versionId: 'newer', label: 'next' }, ...rest],
      floodgate: { ...COMPAT_PINS.floodgate, build: COMPAT_PINS.floodgate.build + 1 },
    }
    expect(behind(COMPAT_PINS, newer)).toEqual([
      `${first.name}: ${first.label} -> next`,
      `Floodgate: ${COMPAT_PINS.floodgate.version} build ${COMPAT_PINS.floodgate.build} -> ${COMPAT_PINS.floodgate.version} build ${COMPAT_PINS.floodgate.build + 1}`,
    ])
  })
})

describe('heldBack', () => {
  const pin = { name: 'ViaVersion', projectId: 'p', versionId: 'a', label: 'a', sha512: '' }

  test('names a newer release that one Minecraft release lacks, and which', () => {
    const lists = [[version('a', 1), version('b', 2)], [version('a', 1)]]
    expect(heldBack(pin, lists, ['26.2', '26.3'])).toBe(
      'ViaVersion: b is out but not for 26.3, which servers here run; the pin stays',
    )
  })

  test('is null where the newest release is the pin, or the one bump takes', () => {
    expect(heldBack(pin, [[version('a', 1)], [version('a', 1)]], ['26.2', '26.3'])).toBeNull()
    expect(
      heldBack(pin, [[version('a', 1), version('b', 2)], [version('b', 2)]], ['26.2', '26.3']),
    ).toBeNull()
  })
})
