// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A subject that runs out of time ends with a complete report that names what was not evaluated,
 * and that report fails. Stopping at a mutant's first failing test never earns credit it lacks.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { mutationVerdict, runMutation } from './mutation.mjs'
import { readMutationJUnit } from './mutation-evidence.mjs'

const commandScript = fileURLToPath(new URL('./mutation-command.mjs', import.meta.url))

const junit = (suites) =>
  `<?xml version="1.0"?><testsuites>${suites
    .map(
      ([file, cases]) =>
        `<testsuite name="${file}" file="${file}">${cases.map((body, index) => `<testcase name="case ${index}">${body}</testcase>`).join('')}</testsuite>`,
    )
    .join('')}</testsuites>`

test('mutants not run within the budget get no kill credit and are counted', () => {
  const mutants = Array.from({ length: 5 }, (_, index) => ({ id: String(index), status: 'Killed' }))
  const evidence = {
    baseline: { status: 'passed', passed: 1, failed: 0, skipped: 0, skippedTests: [] },
    ...Object.fromEntries(
      mutants.map((mutant, index) => [
        mutant.id,
        index < 3
          ? { status: 'test-failure', passed: 0, failed: 1, skipped: 0 }
          : { status: 'budget-exhausted', passed: 0, failed: 0, skipped: 0 },
      ]),
    ),
  }
  const verdict = mutationVerdict({ files: { 'a.ts': { mutants } } }, ['a.ts'], { evidence })
  const row = verdict.files[0]
  assert.equal(row.killed, 3)
  assert.equal(row.unevaluated, 2)
  assert.equal(row.inconclusive, 2)
  assert.equal(row.score, 60)
  assert.equal(verdict.passed, false)
})

test('a kill that stops at its first failure may skip fewer cases, never new ones', () => {
  const report = { files: { 'a.ts': { mutants: [{ id: '0', status: 'Killed' }] } } }
  const baseline = { status: 'passed', passed: 2, failed: 0, skipped: 1, skippedTests: ['live'] }
  const fewer = { status: 'test-failure', passed: 0, failed: 1, skipped: 0, skippedTests: [] }
  assert.equal(mutationVerdict(report, ['a.ts'], { evidence: { baseline, 0: fewer } }).files[0].killed, 1)
  const survivor = { files: { 'a.ts': { mutants: [{ id: '0', status: 'Survived' }] } } }
  const passedFewer = { status: 'passed', passed: 2, failed: 0, skipped: 0, skippedTests: [] }
  assert.throws(
    () => mutationVerdict(survivor, ['a.ts'], { evidence: { baseline, 0: passedFewer } }),
    /valid test evidence/,
  )
})

test('stopping at the first failure may leave later files unreported only after a failure', () => {
  const failed = junit([['a.test.ts', ['<failure message="no"/>']]])
  const passed = junit([['a.test.ts', ['']]])
  assert.equal(readMutationJUnit(failed, ['a.test.ts', 'b.test.ts'], { bail: true }).failed, 1)
  assert.throws(() => readMutationJUnit(failed, ['a.test.ts', 'b.test.ts']), /did not report: b\.test\.ts/)
  assert.throws(
    () => readMutationJUnit(passed, ['a.test.ts', 'b.test.ts'], { bail: true }),
    /did not report: b\.test\.ts/,
  )
})

test('a mutant that starts after the deadline is recorded as not evaluated without running tests', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-budget-command-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const evidence = join(root, 'evidence')
  mkdirSync(evidence)
  writeFileSync(join(evidence, 'baseline.json'), JSON.stringify({ status: 'passed', durationMs: 10 }))
  const marker = join(root, 'ran')
  // A "bun" that would leave a marker if the runner were started at all.
  const bun = join(root, 'bun')
  writeFileSync(bun, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  const manifest = join(root, 'tests.json')
  writeFileSync(
    manifest,
    JSON.stringify({ tests: ['a.test.ts'], evidence, bun, timeoutMs: SECOND_MS, deadline: Date.now() - 1 }),
  )
  const run = spawnSync(process.execPath, [commandScript, manifest], {
    cwd: root,
    env: { ...process.env, __STRYKER_ACTIVE_MUTANT__: '7' },
    encoding: 'utf8',
  })
  assert.equal(run.status, 1, 'Stryker sees a failure, never a pass')
  const outcome = JSON.parse(readFileSync(join(evidence, '7.json'), 'utf8'))
  assert.equal(outcome.status, 'budget-exhausted')
  assert.match(outcome.reason, /time budget/)
  assert.equal(outcome.passed + outcome.failed, 0)
  assert.throws(() => readFileSync(marker), /ENOENT/)
})

test('a subject that outgrows its budget finishes with a failing report instead of a killed run', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-budget-'))
  const reports = mkdtempSync(join(tmpdir(), 'mutation-budget-report-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(reports, { recursive: true, force: true })
  })
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  write(
    'apps/source.ts',
    "export function advance(value: number) { if (value < 0) throw new RangeError('negative'); if (value >= 10) return 10; return value + 1 }\n",
  )
  write(
    'apps/slow.test.ts',
    `import { expect, test } from 'bun:test'\nimport { advance } from './source'\ntest('slow and strict', async () => { expect(() => advance(-1)).toThrow('negative'); await Bun.sleep(${8 * SECOND_MS}); expect(advance(0)).toBe(1); expect(advance(9)).toBe(10); expect(advance(10)).toBe(10); expect(advance(11)).toBe(10) }, ${20 * SECOND_MS})\n`,
  )
  write(
    'apps/other.test.ts',
    "import { expect, test } from 'bun:test'\nimport { advance } from './source'\ntest('other', () => { expect(advance(0)).toBe(1) })\n",
  )
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '--quiet', '--template=', '-b', 'fixture')
  git('add', '--all')
  git(
    '-c',
    'user.name=Quality fixture',
    '-c',
    'user.email=quality@example.invalid',
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    'Fixture',
  )
  const started = Date.now()
  assert.throws(
    () =>
      runMutation({
        root,
        subjects: ['apps/source.ts'],
        testsByFile: { 'apps/source.ts': ['apps/slow.test.ts'] },
        // An expansion past the deadline could evaluate nothing, so it must not start.
        additionalTestsByFile: { 'apps/source.ts': [['apps/other.test.ts']] },
        reportDir: reports,
        timeoutMs: 10 * SECOND_MS,
        subjectTimeoutMs: 30 * SECOND_MS,
      }),
    /mutants were not evaluated within the 0\.5-minute budget/,
  )
  assert.ok(Date.now() - started < 30 * SECOND_MS, 'Stryker finished inside the budget')
  const summary = JSON.parse(readFileSync(join(reports, 'summary.json'), 'utf8'))
  assert.equal(summary.passed, false)
  const row = summary.files[0]
  assert.ok(row.unevaluated > 0, 'some mutants were left unevaluated')
  assert.ok(row.killed > 0, 'mutants before the deadline were judged normally')
  assert.ok(row.score < 80)
  assert.doesNotMatch(summary.failures[0].error, /ETIMEDOUT|failed to finish/)
  const attempts = JSON.parse(readFileSync(join(reports, '0', 'attempts.json'), 'utf8'))
  assert.equal(attempts.length, 1, 'no expansion started after the deadline')
  t.diagnostic(
    `${row.unevaluated} of ${row.total} mutants unevaluated; ${row.killed} killed before the deadline`,
  )
})

test('a running Bun command is capped by the shared deadline, not its longer test timeout', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-running-deadline-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const evidence = join(root, 'evidence')
  mkdirSync(evidence)
  writeFileSync(
    join(root, 'a.test.ts'),
    `import {test} from 'bun:test';import{writeFileSync}from'node:fs';test('still running',async()=>{writeFileSync('started','yes');await Bun.sleep(${10 * SECOND_MS})},${20 * SECOND_MS})`,
  )
  writeFileSync(
    join(evidence, 'baseline.json'),
    JSON.stringify({
      status: 'passed',
      durationMs: 10 * SECOND_MS,
      passed: 1,
      failed: 0,
      skipped: 0,
      skippedTests: [],
    }),
  )
  const manifest = join(root, 'tests.json')
  writeFileSync(
    manifest,
    JSON.stringify({
      tests: ['a.test.ts'],
      evidence,
      bun: 'bun',
      timeoutMs: 20 * SECOND_MS,
      deadline: Date.now() + 2 * SECOND_MS,
    }),
  )
  const began = Date.now()
  const run = spawnSync(process.execPath, [commandScript, manifest], {
    cwd: root,
    env: { ...process.env, __STRYKER_ACTIVE_MUTANT__: '7' },
    encoding: 'utf8',
    timeout: 5 * SECOND_MS,
  })
  assert.equal(run.status, 1)
  assert.equal(readFileSync(join(root, 'started'), 'utf8'), 'yes')
  const outcome = JSON.parse(readFileSync(join(evidence, '7.json'), 'utf8'))
  assert.equal(outcome.status, 'timeout')
  assert.equal(outcome.passed + outcome.failed, 0)
  assert.ok(Date.now() - began < 5 * SECOND_MS)
})
