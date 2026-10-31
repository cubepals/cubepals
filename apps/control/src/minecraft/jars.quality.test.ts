// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Loader destinations and content-derived filenames are the image's jar-installation contract. */
import { expect, test } from 'bun:test'
import type { ModArtifact } from '../domain/mods/artifact.ts'
import { diskName, JAR_LISTS, jarsOf } from './jars.ts'

test('vanilla installs no jars, Paper installs plugins, and mod loaders install mods', () => {
  expect(jarsOf('vanilla')).toBeNull()
  expect(jarsOf('paper')).toEqual({ dir: '/data/plugins', env: 'PLUGINS' })
  for (const loader of ['fabric', 'forge', 'neoforge', 'quilt'] as const)
    expect(jarsOf(loader)).toEqual({ dir: '/data/mods', env: 'MODS' })
})

test('plain and compressed jar lists use valid, distinct image environment bindings', () => {
  const names: string[] = []
  for (const loader of ['paper', 'fabric'] as const) {
    const destination = jarsOf(loader)
    expect(destination).not.toBeNull()
    if (destination === null) throw new Error('A jar loader needs a destination')
    const variables = JAR_LISTS[destination.env]
    expect(variables.plain).toBe(destination.env)
    for (const variable of [variables.plain, variables.compressed]) {
      expect(variable).toMatch(/^[A-Z][A-Z0-9_]*$/)
      names.push(variable)
    }
  }
  expect(new Set(names).size).toBe(4)
})

test('jar names include the exact content prefix while preserving the published filename', () => {
  const artifact: ModArtifact = {
    ref: { kind: 'remote', url: 'https://example.test/mod.jar' },
    sha512: `0123456789ab${'cd'.repeat(58)}`,
    sizeBytes: 1,
    fileName: 'mod.jar',
  }
  expect(diskName(artifact)).toBe('0123456789ab-mod.jar')
  expect(diskName({ ...artifact, fileName: 'Mod with spaces.jar' })).toBe('0123456789ab-Mod with spaces.jar')
  expect(diskName({ ...artifact, sha512: `fedcba987654${'cd'.repeat(58)}` })).toBe('fedcba987654-mod.jar')
})
