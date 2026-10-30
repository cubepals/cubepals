// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Runs real Stryker/Bun gates against strong tests, weakened assertions and a deliberate defect. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMutation } from './mutation.mjs'

export function proveMutation(output, { bun = 'bun' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'blockly-mutation-proof-'))
  const results = []
  const subject = 'packages/probe/src/[limit]/advance.ts'
  const testFile = 'apps/probe.test.ts'
  const source =
    "export function advance(value: number) { if (value < 0) throw new RangeError('negative'); if (value >= 10) return 10; return value + 1 }\n"
  const strong =
    "import { expect, test } from 'bun:test'; import { advance } from '@blockly/probe'; test('bounds and refusal', () => { expect(() => advance(-1)).toThrow('negative'); expect(advance(0)).toBe(1); expect(advance(9)).toBe(10); expect(advance(10)).toBe(10); expect(advance(11)).toBe(10) })\n"
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  try {
    write('.gitignore', 'node_modules/\n')
    write('package.json', JSON.stringify({ private: true, type: 'module' }))
    write(
      'packages/probe/package.json',
      JSON.stringify({ name: '@blockly/probe', type: 'module', exports: './src/[limit]/advance.ts' }),
    )
    write(subject, source)
    write(testFile, strong)
    mkdirSync(join(root, 'node_modules/@blockly'), { recursive: true })
    symlinkSync('../../packages/probe', join(root, 'node_modules/@blockly/probe'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    const run = (name) =>
      runMutation({
        root,
        subjects: [subject],
        testsByFile: { [subject]: [testFile] },
        reportDir: join(output, name),
        bun,
        timeoutMs: 15_000,
        subjectTimeoutMs: 180_000,
      })
    const baseline = run('strong')
    assert.equal(baseline.passed, true)
    results.push({
      case: 'strong boundary/refusal tests through workspace import',
      rejected: false,
      score: baseline.files[0].score,
    })
    write(
      testFile,
      "import { expect, test } from 'bun:test'; import { advance } from '@blockly/probe'; test('exists', () => { expect(advance(0)).toBeDefined(); expect(advance(10)).toBeDefined() })\n",
    )
    assert.throws(() => run('weak'), /mutation score .* below/)
    const weak = JSON.parse(readFileSync(join(output, 'weak/summary.json'), 'utf8'))
    assert.equal(weak.passed, false)
    results.push({ case: 'superficial toBeDefined assertions', rejected: true, score: weak.files[0].score })
    write(testFile, strong)
    write(subject, source.replace('>= 10', '> 10'))
    assert.throws(() => run('defect'), /produced no report|clean mutation baseline/)
    const log = readFileSync(join(output, 'defect/0/stryker.log'), 'utf8')
    assert.match(log, /failed tests in the initial test run|tests failed in the initial test run/i)
    results.push({
      case: 'off-by-one production defect',
      rejected: true,
      reason: 'clean test baseline failed',
    })
    write(subject, 'export const version = 1\n')
    write(
      testFile,
      "import { expect, test } from 'bun:test'; import { version } from '@blockly/probe'; test('wire version', () => expect(version).toBe(1))\n",
    )
    const constant = run('constant')
    assert.equal(constant.files[0].score, null)
    assert.match(constant.files[0].notApplicable, /no mutable expressions/)
    results.push({
      case: 'constant with no mutation operators independently enumerated',
      rejected: false,
      score: null,
    })
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'proof.json'), JSON.stringify({ passed: true, cases: results }, null, 2))
    return results
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2] ?? 'coverage/mutation-proof')
  process.stdout.write(`${JSON.stringify(proveMutation(output), null, 2)}\n`)
}
