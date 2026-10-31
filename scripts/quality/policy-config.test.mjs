// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Configuration protection follows complete tool basenames, leaving ordinary product names usable. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectChanges } from './policy.mjs'

const change = (path, before = null, after = 'export const value = 1\n') => ({ path, before, after })

test('ordinary product and test filenames sharing a tool prefix remain editable', () => {
  for (const name of [
    'coverage-map.ts',
    'coverage.ts',
    'coverage-map.test.ts',
    'coverage.config-helper.ts',
    'coverage.config.ts.test.ts',
    'jest-matchers.ts',
    'jest.ts',
    'vitest-adapter.ts',
    'stryker-mutant.ts',
    'nyc-map.json',
    'c8ffff8d.js',
    'istanbul-guide.yaml',
  ]) {
    const path = `apps/product/${name}`
    assert.deepEqual(inspectChanges([change(path)]), [], path)
    assert.deepEqual(inspectChanges([change(path, 'export const value = 0\n')]), [], path)
    assert.deepEqual(inspectChanges([change(path, 'export const value = 0\n', null)]), [], path)
  }
})

test('config and legacy conf basenames remain protected at the root and in workspaces', () => {
  for (const tool of ['vitest', 'jest', 'stryker', 'nyc', 'c8', 'istanbul', 'coverage']) {
    for (const kind of ['config', 'conf']) {
      for (const extension of ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts', 'json', 'toml', 'yml', 'yaml']) {
        for (const prefix of ['', 'apps/product/']) {
          const path = `${prefix}${tool}.${kind}.${extension}`
          for (const entry of [change(path), change(path, '{}'), change(path, '{}', null)]) {
            assert.match(inspectChanges([entry]).join('\n'), /protected quality infrastructure/, path)
          }
        }
      }
    }
  }
})

test('Vitest workspace discovery and existing hidden transform or coverage configs remain protected', () => {
  for (const path of [
    'vitest.workspace.ts',
    'apps/product/vitest.workspace.mts',
    'vitest.workspace.json',
    '.babelrc',
    'apps/product/.babelrc.json',
    '.babelrc.cjs',
    '.nycrc',
    'apps/product/.nycrc.json',
    '.nycrc.mjs',
    'babel.config.cts',
    'bunfig.toml',
    'scripts/quality/coverage-map.ts',
    'tools/quality/product.ts',
    '.github/workflows/product.yml',
  ]) {
    assert.match(inspectChanges([change(path)]).join('\n'), /protected quality infrastructure/, path)
  }
})
