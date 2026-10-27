// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pack a modded world was played with: which of its versions opens the world, and when a
 * pack Cubepals picked would move the world to a newer Minecraft without its owner asking.
 */

import { describe, expect, test } from 'bun:test'
import type { ServerSetup } from '../../domain/setup/setup.ts'
import type { BroughtWorld } from '../backups/new-world-imports.ts'
import { fittedToWorld, packForWorld } from './brought-with-pack.ts'

/** A world last saved on `gameVersion`, which Cubepals opens on `playsOn`. */
const world = (gameVersion: string, playsOn = gameVersion): BroughtWorld => ({
  facts: {
    name: 'Valley',
    gameVersion,
    playsOn,
    seed: null,
    levelType: 'minecraft:normal',
    hardcore: false,
    gameMode: 'survival',
    difficulty: 'easy',
    sizeBytes: 1,
    moddedWith: ['fabric'],
  },
  startsOn: {
    ref: { kind: 'stored', key: 'k' },
    sha512: 'a'.repeat(128),
    sizeBytes: 1,
    fileName: 'world.tar.gz',
  },
})

/** What a pack resolved to, on `gameVersion`. */
const resolved = (gameVersion: string) => ({
  gameVersion,
  from: 'Valley Pack',
  notes: [] as string[],
  setup: {
    settings: {},
    world: { levelType: 'minecraft:normal', hardcore: false },
  } as unknown as ServerSetup,
})

describe('the pack a world was played with', () => {
  test('a catalog pack takes its newest version for the world’s own release, then the one it opens on', async () => {
    const versions = async () => [
      { versionId: 'v3', gameVersions: ['1.21.11'], publishedAt: new Date(3) },
      { versionId: 'v2', gameVersions: ['1.21.10'], publishedAt: new Date(2) },
      { versionId: 'v1', gameVersions: ['1.21.10', '1.21.11'], publishedAt: new Date(1) },
    ]
    const pack = { kind: 'modpack', projectId: 'valley' } as const
    // A world saved on a release Cubepals doesn't offer, opened on the next: the pack's own for it.
    expect(await packForWorld(pack, world('1.21.10', '1.21.11'), versions)).toEqual({
      ...pack,
      versionId: 'v2',
    })
    expect(await packForWorld(pack, world('1.21.11'), versions)).toEqual({ ...pack, versionId: 'v3' })
    // A version its owner named is theirs.
    expect(await packForWorld({ ...pack, versionId: 'v1' }, world('1.21.11'), versions)).toEqual({
      ...pack,
      versionId: 'v1',
    })
  })

  test('a pack on the world’s own release opens it, though Cubepals would open it on another', () => {
    const fitted = fittedToWorld(resolved('1.21.10'), world('1.21.10', '1.21.11'), {
      kind: 'modpack',
      projectId: 'valley',
    })
    expect(fitted.notes).toEqual([])
  })

  test('a newest release Cubepals took for its owner never moves the world to a newer Minecraft', () => {
    const newer = resolved('26.3')
    for (const pack of [
      { kind: 'modpack', projectId: 'valley' },
      { kind: 'curated', key: 'valley' },
    ] as const)
      expect(() => fittedToWorld(newer, world('1.21.11'), pack)).toThrow(
        'No version of Valley Pack runs Minecraft 1.21.11, which this world was played on. Choose the version it was played with, or one on a newer Minecraft to update the world to.',
      )
    // A version, a release or a file its owner chose does, and says so.
    for (const pack of [
      { kind: 'modpack', projectId: 'valley', versionId: 'v4' },
      { kind: 'curated', key: 'valley', version: '2.0' },
      { kind: 'import', importId: '0b6c0a6e-5d8e-4b3e-9a43-7d3c1f0c2b11' },
    ] as const)
      expect(fittedToWorld(newer, world('1.21.11'), pack).notes).toEqual([
        'It was last played on Minecraft 1.21.11. Valley Pack runs 26.3, which updates it when it first starts.',
      ])
  })
})
