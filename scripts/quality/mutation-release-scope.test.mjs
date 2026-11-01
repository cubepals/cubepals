// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Release scope is Git-verified, bounded to changed code, and distinct from coverage debt. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { inventory, sourceFiles } from './inventory.mjs'
import { selectReleaseMutationScope } from './mutation-release-scope.mjs'
import { selectMutationScope } from './mutation-scope.mjs'

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-mutation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  git('init', '--quiet', '--template=', '-b', 'fixture')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'user.name', 'Quality fixture')
  git('config', 'user.email', 'quality@example.invalid')
  const commit = () => {
    git('add', '--all')
    git('commit', '--quiet', '--no-gpg-sign', '-m', 'Fixture change')
    return git('rev-parse', 'HEAD')
  }
  write('apps/source.ts', 'export const value = () => 42')
  write('apps/legacy.ts', 'export const legacy = () => 7')
  write(
    'apps/source.test.ts',
    "import {value} from './source'; import {legacy} from './legacy'; value(); legacy()",
  )
  const baseSha = commit()
  const input = () => {
    const entries = inventory(root)
    return {
      root,
      baseSha,
      headSha: git('rev-parse', 'HEAD'),
      productionFiles: sourceFiles(entries),
      testFiles: entries.filter((entry) => entry.kind === 'test').map((entry) => entry.path),
      changedFiles: git('diff', '--name-only', '--no-renames', baseSha, 'HEAD').split('\n').filter(Boolean),
    }
  }
  return { root, write, commit, input }
}

test('editing an integration test leaves release mutations empty and coverage impact intact', (t) => {
  const r = repository(t)
  r.write(
    'apps/source.test.ts',
    "import {value} from './source'; import {legacy} from './legacy'; if(value()) legacy()",
  )
  r.commit()
  const release = selectReleaseMutationScope(r.input())
  assert.deepEqual(release.subjects, [])
  assert.equal(release.baseScore, null)
  assert.deepEqual(selectMutationScope(r.input()).subjects, ['apps/legacy.ts', 'apps/source.ts'])
})

test('changed source keeps all dependent tests without importing legacy mutation debt', (t) => {
  const r = repository(t)
  r.write('apps/source.ts', 'export const value = () => 43')
  r.write('apps/new.ts', 'export const created = () => 1')
  r.commit()
  const release = selectReleaseMutationScope(r.input())
  assert.deepEqual(release.subjects, ['apps/new.ts', 'apps/source.ts'])
  assert.deepEqual(release.testsByFile['apps/source.ts'], ['apps/source.test.ts'])
  assert.deepEqual(release.testsByFile['apps/new.ts'], [])
})

test('config changes and test deletions do not silently request a full release audit', (t) => {
  const r = repository(t)
  r.write('package.json', JSON.stringify({ private: true }))
  rmSync(join(r.root, 'apps/source.test.ts'))
  r.commit()
  assert.deepEqual(selectReleaseMutationScope(r.input()).subjects, [])
  assert.deepEqual(selectReleaseMutationScope({ ...r.input(), full: true }).subjects, [
    'apps/legacy.ts',
    'apps/source.ts',
  ])
})

test('unresolvable production imports still fail the independent inventory verifier', (t) => {
  const r = repository(t)
  r.write('apps/source.ts', 'export const value = () => import(globalThis.path)')
  r.commit()
  assert.throws(() => selectReleaseMutationScope(r.input()), /Unresolved dynamic module import/)
})

test('a caller cannot omit source edits from the authoritative Git diff', (t) => {
  const r = repository(t)
  r.write('apps/source.ts', 'export const value = () => 43')
  r.commit()
  assert.throws(
    () => selectReleaseMutationScope({ ...r.input(), changedFiles: [] }),
    /complete base-to-head Git diff/,
  )
})
