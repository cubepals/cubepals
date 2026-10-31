// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Mutation selection retains existing evidence and expands whole candidate runs when needed. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { selectMutationScope } from './mutation-scope.mjs'

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-selection-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

test('a new narrow case cannot replace existing direct tests with unrelated filenames', (t) => {
  const root = fixture(t, {
    'apps/source.ts': 'export const value = () => 42',
    'apps/source.quality.test.ts': "import {value} from './source'; value()",
    'apps/contracts.test.ts': "import {value} from './source'; value()",
    'apps/unrelated.ts': 'export const other = 3',
    'apps/unrelated.test.ts': "import {other} from './unrelated'; other",
  })
  const scope = selectMutationScope({
    root,
    productionFiles: ['apps/source.ts', 'apps/unrelated.ts'],
    testFiles: ['apps/source.quality.test.ts', 'apps/contracts.test.ts', 'apps/unrelated.test.ts'],
    changedFiles: ['apps/source.quality.test.ts'],
  })
  assert.deepEqual(scope.subjects, ['apps/source.ts'])
  assert.deepEqual(scope.testsByFile['apps/source.ts'], [
    'apps/contracts.test.ts',
    'apps/source.quality.test.ts',
  ])
  assert.deepEqual(scope.additionalTestsByFile['apps/source.ts'], [])
})

test('existing indirect tests remain in ordered expansion batches after a new direct test', (t) => {
  const files = {
    'apps/source.ts': 'export const value = () => 42',
    'apps/adapter.ts': "export {value} from './source'",
    'apps/deep.ts': "export {value} from './adapter'",
    'apps/new.test.ts': "import {value} from './source'; value()",
    'apps/deep.test.ts': "import {value} from './deep'; value()",
  }
  const adjacent = Array.from({ length: 6 }, (_, index) => `apps/existing-${index}.test.ts`)
  for (const file of adjacent) files[file] = "import {value} from './adapter'; value()"
  const root = fixture(t, files)
  const scope = selectMutationScope({
    root,
    productionFiles: ['apps/source.ts', 'apps/adapter.ts', 'apps/deep.ts'],
    testFiles: ['apps/new.test.ts', 'apps/deep.test.ts', ...adjacent],
    changedFiles: ['apps/new.test.ts'],
  })
  assert.deepEqual(scope.testsByFile['apps/source.ts'], ['apps/new.test.ts'])
  assert.deepEqual(scope.additionalTestsByFile['apps/source.ts'], [
    adjacent.slice(0, 4),
    adjacent.slice(4),
    ['apps/deep.test.ts'],
  ])
  assert.equal(new Set(scope.additionalTestsByFile['apps/source.ts'].flat()).size, 7)
})

test('changed indirect tests remain available when an inexpensive direct suite runs first', (t) => {
  const root = fixture(t, {
    'apps/source.ts': 'export const value = () => 42',
    'apps/adapter.ts': "export {value} from './source'",
    'apps/direct.test.ts': "import {value} from './source'; value()",
    'apps/changed.test.ts': "import {value} from './adapter'; value()",
    'apps/existing.test.ts': "import {value} from './adapter'; value()",
  })
  const scope = selectMutationScope({
    root,
    productionFiles: ['apps/source.ts', 'apps/adapter.ts'],
    testFiles: ['apps/direct.test.ts', 'apps/changed.test.ts', 'apps/existing.test.ts'],
    changedFiles: ['apps/changed.test.ts'],
  })
  assert.deepEqual(scope.testsByFile['apps/source.ts'], ['apps/direct.test.ts'])
  assert.deepEqual(scope.additionalTestsByFile['apps/source.ts'], [
    ['apps/changed.test.ts', 'apps/existing.test.ts'],
  ])
})

test('large direct integration runners wait behind inexpensive direct and indirect evidence', (t) => {
  const files = {
    'apps/source.ts': 'export const value = () => 42',
    'apps/adapter.ts': "export {value} from './source'",
    'apps/source.quality.test.ts': "import {value} from './source'; value()",
    'apps/unit.test.ts': "import {value} from './source'; value()",
    'apps/indirect.test.ts': "import {value} from './adapter'; value()",
  }
  const setupFiles = Array.from({ length: 8 }, (_, index) => `apps/setup-${index}.ts`)
  for (const file of setupFiles) files[file] = 'export const ready = true'
  files['apps/integration.test.ts'] = [
    "import {value} from './source'; value()",
    ...setupFiles.map((file) => `import './${file.slice('apps/'.length)}'`),
  ].join('\n')
  const root = fixture(t, files)
  const testFiles = [
    'apps/integration.test.ts',
    'apps/indirect.test.ts',
    'apps/source.quality.test.ts',
    'apps/unit.test.ts',
  ]
  const scope = selectMutationScope({
    root,
    productionFiles: ['apps/source.ts', 'apps/adapter.ts', ...setupFiles],
    testFiles,
    changedFiles: ['apps/source.quality.test.ts'],
  })
  assert.deepEqual(scope.subjects, ['apps/source.ts'])
  assert.deepEqual(scope.testsByFile['apps/source.ts'], ['apps/source.quality.test.ts', 'apps/unit.test.ts'])
  assert.deepEqual(scope.additionalTestsByFile['apps/source.ts'], [
    ['apps/indirect.test.ts'],
    ['apps/integration.test.ts'],
  ])
  assert.deepEqual(
    [...scope.testsByFile['apps/source.ts'], ...scope.additionalTestsByFile['apps/source.ts'].flat()].sort(),
    [...testFiles].sort(),
  )
})

test('an edited integration runner may follow cheap independent proof without losing source scope', (t) => {
  const root = fixture(t, {
    'apps/source.ts': 'export const value = () => 42',
    'apps/adapter.ts': "export {value} from './source'",
    'apps/setup.ts': 'export const ready = true',
    'apps/unit.test.ts': "import {value} from './source'; value()",
    'apps/integration.test.ts': "import './setup'; import {value} from './adapter'; value()",
  })
  const scope = selectMutationScope({
    root,
    productionFiles: ['apps/source.ts', 'apps/adapter.ts', 'apps/setup.ts'],
    testFiles: ['apps/unit.test.ts', 'apps/integration.test.ts'],
    changedFiles: ['apps/integration.test.ts'],
  })
  assert.deepEqual(scope.testsByFile['apps/source.ts'], ['apps/unit.test.ts'])
  assert.deepEqual(scope.additionalTestsByFile['apps/source.ts'], [['apps/integration.test.ts']])
  assert.deepEqual(scope.subjects, ['apps/adapter.ts', 'apps/setup.ts', 'apps/source.ts'])
})

test('a narrow indirect suite precedes the only direct runner when that runner loads a large harness', (t) => {
  const files = {
    'apps/source.ts': 'export const value = () => 42',
    'apps/adapter.ts': "export {value} from './source'",
    'apps/new.test.ts': "import {value} from './adapter'; value()",
  }
  const setupFiles = Array.from({ length: 8 }, (_, index) => `apps/setup-${index}.ts`)
  for (const file of setupFiles) files[file] = 'export const ready = true'
  files['apps/source.test.ts'] = [
    "import {value} from './source'; value()",
    ...setupFiles.map((file) => `import './${file.slice('apps/'.length)}'`),
  ].join('\n')
  const root = fixture(t, files)
  const scope = selectMutationScope({
    root,
    productionFiles: ['apps/source.ts', 'apps/adapter.ts', ...setupFiles],
    testFiles: ['apps/source.test.ts', 'apps/new.test.ts'],
    changedFiles: ['apps/new.test.ts'],
  })
  assert.deepEqual(scope.testsByFile['apps/source.ts'], ['apps/new.test.ts'])
  assert.deepEqual(scope.additionalTestsByFile['apps/source.ts'], [['apps/source.test.ts']])
})

test('an ambiguous possible runner cannot displace a proven dependent merely by being small', (t) => {
  const root = fixture(t, {
    'apps/source.ts': 'export const value = () => 42',
    'apps/unit.test.ts': "import {value} from './source'; value()",
    'apps/dynamic.test.ts': 'const loaded = await import(globalThis.path); loaded.run()',
  })
  const scope = selectMutationScope({
    root,
    productionFiles: ['apps/source.ts'],
    testFiles: ['apps/dynamic.test.ts', 'apps/unit.test.ts'],
    changedFiles: ['apps/source.ts'],
  })
  assert.deepEqual(scope.testsByFile['apps/source.ts'], ['apps/unit.test.ts'])
  assert.deepEqual(scope.additionalTestsByFile['apps/source.ts'], [['apps/dynamic.test.ts']])
})
