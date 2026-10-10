// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { PinnedMod } from '../domain/mods/artifact.ts'
import { resetHeartsCommand, runsLifeSteal } from './lifesteal.ts'

const plugin = (catalog: string, projectId: string): PinnedMod => ({
  source: { catalog, projectId, versionId: 'v' },
  name: projectId,
  versionLabel: '1',
  artifact: { ref: { kind: 'stored', key: 'k' }, sha512: 'x', sizeBytes: 1, fileName: 'a.jar' },
  environment: 'server',
  loaders: ['paper'],
  gameVersions: ['26.2'],
  origin: 'user',
  requiredBy: [],
})

describe('LifeStealZ', () => {
  test('a server runs it when its plugins include LifeStealZ from Modrinth', () => {
    expect(runsLifeSteal([plugin('modrinth', 'manhunt'), plugin('modrinth', 'l8Uv7FzS')])).toBe(true)
    expect(runsLifeSteal([plugin('hangar', 'l8Uv7FzS')])).toBe(false)
    expect(runsLifeSteal([])).toBe(false)
  })

  test('resetting the hearts removes its database, and nothing else of its folder', () => {
    expect(resetHeartsCommand()).toEqual([
      'sh',
      '-c',
      'cd /data && rm -f -- plugins/LifeStealZ/userData.db plugins/LifeStealZ/userData.db-journal plugins/LifeStealZ/userData.db-wal plugins/LifeStealZ/userData.db-shm',
    ])
  })
})
