// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Which players' games a server takes, by its release and Via plugins, against minecraft-data's numbers. */

import { describe, expect, test } from 'bun:test'
import type { PinnedMod } from '../domain/mods/artifact.ts'
import { clientRange, protocolOf, RELEASES } from './clients.ts'
import { VIABACKWARDS, VIAREWIND, VIAVERSION } from './mods.ts'

const plugin = (projectId: string, name: string, catalog = 'modrinth'): PinnedMod => ({
  source: { catalog, projectId, versionId: 'v' },
  name,
  versionLabel: '1',
  artifact: {
    ref: { kind: 'remote', url: 'https://cdn.test/p.jar' },
    sha512: '',
    sizeBytes: 1,
    fileName: `${name}.jar`,
  },
  environment: 'server',
  loaders: ['paper'],
  gameVersions: ['26.2'],
  origin: 'user',
  requiredBy: [],
})

const VV = plugin(VIAVERSION, 'ViaVersion')
const VB = plugin(VIABACKWARDS, 'ViaBackwards')
const VR = plugin(VIAREWIND, 'ViaRewind')

describe('which clients a server takes', () => {
  test('the published numbers', () => {
    expect(protocolOf('26.2')).toBe(776)
    expect(protocolOf('1.21.11')).toBe(774)
    // Two releases that speak one number.
    expect(protocolOf('1.21.9')).toBe(protocolOf('1.21.10'))
    expect(protocolOf('1.9')).toBe(107)
    expect(protocolOf('1.7.2')).toBe(4)
    expect(protocolOf('26.4-snapshot-1')).toBeNull()
    expect(RELEASES.every((release) => /^\d+\.\d+(\.\d+)?$/.test(release.name))).toBe(true)
  })

  test('its own release alone, without the Via plugins', () => {
    expect(clientRange('26.2', 'paper', [])).toEqual({
      release: '26.2',
      protocol: 776,
      oldest: 776,
      oldestRelease: '26.2',
      newest: 776,
    })
  })

  test('newer clients with ViaVersion, older ones down to 1.9 with ViaBackwards, 1.7 with ViaRewind', () => {
    expect(clientRange('26.2', 'paper', [VV])).toMatchObject({ oldest: 776, newest: null })
    expect(clientRange('26.2', 'paper', [VV, VB])).toMatchObject({
      oldest: 107,
      oldestRelease: '1.9',
      newest: null,
    })
    expect(clientRange('26.2', 'paper', [VV, VB, VR])).toMatchObject({ oldest: 4, oldestRelease: '1.7.2' })
  })

  test('the addons do nothing without ViaVersion', () => {
    expect(clientRange('26.2', 'paper', [VB, VR])).toMatchObject({ oldest: 776, newest: 776 })
  })

  test('a Via plugin from Hangar counts as the same plugin', () => {
    const hangar = [plugin('hangar:7', 'ViaVersion', 'hangar'), plugin('hangar:12', 'ViaBackwards', 'hangar')]
    expect(clientRange('26.2', 'paper', hangar)).toMatchObject({ oldest: 107, newest: null })
  })

  test('only Paper runs them', () => {
    expect(clientRange('26.2', 'fabric', [VV, VB])).toMatchObject({ oldest: 776, newest: 776 })
    expect(clientRange('1.21.10', 'vanilla', [])).toMatchObject({ oldest: 773, newest: 773 })
  })

  test('a release the table doesn’t know takes whatever it takes', () => {
    expect(clientRange('27.1', 'paper', [VV])).toBeNull()
  })
})
