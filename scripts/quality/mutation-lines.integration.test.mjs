// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real pinned Stryker proves selected-line census, strong/weak tests and tamper rejection. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mutationVerdict, runMutation } from './mutation.mjs'
import { mutationLineRanges } from './mutation-lines.mjs'

test('changed code is tested completely without inheriting untouched legacy mutations', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-line-proof-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  mkdirSync(join(root, 'apps/[room]'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  git('init', '-q', '--template=', '-b', 'fixture')
  git('config', 'user.name', 'Quality fixture')
  git('config', 'user.email', 'quality@example.invalid')
  const subject = 'apps/[room]/value.ts',
    oracle = 'apps/value.test.ts'
  const source =
    "export const legacy = (x: number) => { if (x < 0) throw new Error('old'); return x * 3 }\nexport const changed = (x: number) => x + 1\nexport type Alias = string\n"
  writeFileSync(join(root, subject), source)
  git('add', '.')
  git('commit', '-qm', 'Base fixture')
  const baseSha = git('rev-parse', 'HEAD')
  const proposed = source.replace('x + 1', 'x + 2')
  writeFileSync(join(root, subject), proposed)
  const strong =
    "import{test,expect}from'bun:test';import{changed}from'./[room]/value';test('increments by two',()=>{expect(changed(0)).toBe(2);expect(changed(4)).toBe(6)})\n"
  writeFileSync(join(root, oracle), strong)
  git('add', '.')
  git('commit', '-qm', 'Change increment')
  const rangesByFile = mutationLineRanges({
    root,
    baseSha,
    headSha: git('rev-parse', 'HEAD'),
    subjects: [subject],
  })
  const run = (name, ranges = rangesByFile) =>
    runMutation({
      root,
      subjects: [subject],
      testsByFile: { [subject]: [oracle] },
      rangesByFile: ranges,
      reportDir: join(root, name),
    })
  const result = run('selected')
  assert.equal(result.passed, true)
  const candidates = JSON.parse(readFileSync(join(root, 'selected/candidates.json'), 'utf8'))
  assert.ok(candidates[subject].wholeFileCount > candidates[subject].count)
  assert.equal(result.files[0].total, candidates[subject].count)
  assert.equal(result.files[0].score, 100)
  const report = JSON.parse(readFileSync(join(root, 'selected/0/mutation.json'), 'utf8'))
  assert.ok(report.files[subject].mutants.every((m) => m.location.start.line === 2))
  const omitted = structuredClone(report)
  omitted.files[subject].mutants.pop()
  assert.throws(
    () => mutationVerdict(omitted, [subject], { candidates, expectedSources: { [subject]: proposed } }),
    /omitted candidates/,
  )
  const moved = structuredClone(report)
  moved.files[subject].mutants[0].location.start.line = 1
  assert.throws(
    () => mutationVerdict(moved, [subject], { candidates, expectedSources: { [subject]: proposed } }),
    /independent candidate identities/,
  )
  writeFileSync(
    join(root, oracle),
    "import{test,expect}from'bun:test';import{changed}from'./[room]/value';test('exists',()=>expect(changed(0)).toBeDefined())\n",
  )
  assert.throws(() => run('weak'), /mutation score .* below/)
  writeFileSync(join(root, oracle), strong)
  assert.throws(() => run('full', null), /mutation score .* below/)
  const types = run('types', { [subject]: [{ start: 3, end: 3 }] })
  assert.equal(types.files[0].total, 0)
  assert.equal(types.files[0].score, null)
})
