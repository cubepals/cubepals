// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Completeness checks reject orphaned work, stale censuses and credit for inconclusive runs. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { mutationLineRanges } from './mutation-lines.mjs'
import { verifyMutationPartitions } from './mutation-partitions.mjs'
import { mutationAssignment } from './partition-plan.mjs'
import { groupOf, groups } from './shards.mjs'

function fixture(changed) {
  const directory = mkdtempSync(join(tmpdir(), 'quality-mutation-partitions-'))
  const root = join(directory, 'repo'),
    reports = join(directory, 'reports')
  const put = (path, data) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
  }
  const subject = 'apps/value.ts'
  put(join(root, subject), 'export const value = (flag: boolean) => flag ? 1 : 0\n')
  put(
    join(root, 'apps/value.test.ts'),
    "import{test,expect}from'bun:test';import{value}from'./value';test('value',()=>expect(value(true)).toBeGreaterThan(0))\n",
  )
  put(join(root, 'scripts/quality/runtime-costs.json'), { tests: {}, mutations: {} })
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'Fixture',
    )
  }
  git('init', '-q', '--template=', '-b', 'main')
  commit()
  const base = git('rev-parse', 'HEAD')
  if (changed) {
    put(join(root, subject), 'export const value = (flag: boolean) => flag ? 2 : 0\n')
    commit()
  } else {
    put(join(root, 'README.md'), 'No production changes\n')
    commit()
  }
  const head = git('rev-parse', 'HEAD'),
    subjects = changed ? [subject] : []
  const input = join(directory, 'input.json'),
    output = join(directory, 'candidates.json')
  put(input, {
    root,
    subjects,
    rangesByFile: mutationLineRanges({ root, baseSha: base, headSha: head, subjects }),
    output,
  })
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./mutation-candidates.mjs', import.meta.url)),
    input,
  ])
  const census = JSON.parse(readFileSync(output))
  for (let index = 0; index < 4; index++) {
    for (const group of Object.keys(groups)) {
      const selected = mutationAssignment(subjects, {}, index).filter((path) => groupOf(path) === group)
      const path = join(reports, String(index), group)
      put(join(path, 'scope.json'), { selected, partition: { index, count: 4 }, rotation: null, full: false })
      put(join(path, 'summary.json'), {
        passed: true,
        complete: true,
        files: selected.map((file) => ({
          file,
          passed: true,
          total: census[file].count,
          killed: census[file].count,
          inconclusive: 0,
          unevaluated: 0,
          threshold: 80,
        })),
      })
      if (selected.length) put(join(path, 'candidates.json'), census)
    }
  }
  return { directory, root, reports, subject, comparison: { base, head } }
}

test('every empty mutation runner must still provide complete, independently checked scope evidence', () => {
  const f = fixture(false)
  try {
    const args = { root: f.root, directory: f.reports, comparison: f.comparison }
    assert.equal(verifyMutationPartitions(args).subjects, 0)
    rmSync(join(f.reports, '3/web/summary.json'))
    assert.throws(() => verifyMutationPartitions(args), /ENOENT/)
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
  }
})

test('independent censuses prevent stale mutants, overlap and timeout credit in partition summaries', () => {
  const f = fixture(true)
  try {
    const args = { root: f.root, directory: f.reports, comparison: f.comparison }
    assert.equal(verifyMutationPartitions(args).subjects, 1)
    const path = join(f.reports, '0/rest/candidates.json'),
      original = readFileSync(path, 'utf8')
    const candidates = JSON.parse(original)
    assert.ok(candidates[f.subject].count > 0)
    candidates[f.subject].identities.pop()
    writeFileSync(path, JSON.stringify(candidates))
    assert.throws(() => verifyMutationPartitions(args), /candidate census/)
    writeFileSync(path, original)
    const scopePath = join(f.reports, '1/rest/scope.json'),
      scopeOriginal = readFileSync(scopePath, 'utf8')
    const scope = JSON.parse(scopeOriginal)
    scope.selected = [f.subject]
    writeFileSync(scopePath, JSON.stringify(scope))
    assert.throws(() => verifyMutationPartitions(args), /partition scope/)
    writeFileSync(scopePath, scopeOriginal)
    const summaryPath = join(f.reports, '0/rest/summary.json'),
      summary = JSON.parse(readFileSync(summaryPath))
    summary.files[0].inconclusive = summary.files[0].total
    summary.files[0].killed = 0
    writeFileSync(summaryPath, JSON.stringify(summary))
    assert.throws(() => verifyMutationPartitions(args), /Unproved mutation detection/)
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
  }
})
