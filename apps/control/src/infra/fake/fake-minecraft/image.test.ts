// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Fake installs expose their selected loader and game identity to the same boot reader as real runtimes. */
import { expect, test } from 'bun:test'
import { bootedWith } from '../../../minecraft/logs.ts'
import { startupBanner } from './image.ts'

test('each selected loader reports its pinned identity through the boot reader', () => {
  for (const loader of ['fabric', 'quilt', 'forge', 'neoforge'] as const) {
    for (const suffix of ['LOADER_VERSION', 'VERSION']) {
      const lines: string[] = []
      startupBanner(
        {
          TYPE: loader.toUpperCase(),
          VERSION: '26.3',
          [`${loader.toUpperCase()}_${suffix}`]: 'loader-build',
        },
        (line) => lines.push(line),
      )
      expect(bootedWith(lines)).toEqual({ gameVersion: '26.3', loader, loaderVersion: 'loader-build' })
    }
  }
})

test('the pack index selects its own identity before environment defaults', () => {
  for (const loader of ['fabric', 'quilt', 'forge', 'neoforge'] as const) {
    const lines: string[] = []
    const key = loader === 'fabric' || loader === 'quilt' ? `${loader}-loader` : loader
    startupBanner({ TYPE: 'VANILLA', VERSION: 'old' }, (line) => lines.push(line), {
      minecraft: '26.3',
      [key]: 'index-build',
    })
    expect(bootedWith(lines)).toEqual({ gameVersion: '26.3', loader, loaderVersion: 'index-build' })
  }
})

test('missing optional identity fields stay unknown', () => {
  const lines: string[] = []
  startupBanner({}, (line) => lines.push(line), {})
  expect(bootedWith(lines)).toMatchObject({ gameVersion: 'unknown', loader: null, loaderVersion: null })
  const fabric: string[] = []
  startupBanner({ TYPE: 'FABRIC', VERSION: '26.3' }, (line) => fabric.push(line))
  expect(bootedWith(fabric)).toEqual({ gameVersion: '26.3', loader: 'fabric', loaderVersion: 'unknown' })
})
