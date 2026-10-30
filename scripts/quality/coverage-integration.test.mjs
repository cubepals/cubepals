// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Exercises the real Bun preload and CLI in disposable repositories. A passing test process
 * must still produce complete evidence, and a real lost negative path or unimported source must
 * make the exact coverage command used by CI exit nonzero.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fileMetrics, validateReport } from './coverage.mjs'
import { inventory } from './inventory.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const bun = process.env.QUALITY_BUN ?? 'bun'
const code = `export function accepts(value: number): boolean {
  if (value < 0) return false
  return value <= 2
}`
const strong = `import { test, expect } from 'bun:test'
import { accepts } from './range.ts'
test('range boundaries', () => {
  expect(accepts(-1)).toBe(false)
  expect(accepts(0)).toBe(true)
  expect(accepts(2)).toBe(true)
  expect(accepts(3)).toBe(false)
})`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'quality-coverage-'))
  execFileSync('git', ['init', '--quiet', root])
  mkdirSync(join(root, 'apps'))
  writeFileSync(join(root, 'apps/range.ts'), code)
  writeFileSync(join(root, 'apps/range.test.ts'), strong)
  return root
}

function run(root, report) {
  const result = spawnSync(
    bun,
    ['test', '--preload', join(here, 'coverage-preload.mjs'), './apps/range.test.ts'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, QUALITY_ROOT: root, QUALITY_REPORT: join(root, report), QUALITY_SHARD: 'proof' },
    },
  )
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  return validateReport(JSON.parse(readFileSync(join(root, report), 'utf8')))
}

test('real negative-path deletion and never-imported source fail the CI coverage CLI', () => {
  const root = fixture()
  try {
    const baseline = run(root, 'base.json')
    for (const metric of Object.values(fileMetrics(baseline.files['apps/range.ts'])))
      assert.equal(metric.percent, 100)
    writeFileSync(join(root, 'changed.json'), JSON.stringify(['apps/range.ts']))
    const command = ['scripts/quality/coverage.mjs', 'check']
    command[0] = resolve(here, 'coverage.mjs')
    const args = [
      ...command,
      '--report',
      join(root, 'head.json'),
      '--base',
      join(root, 'base.json'),
      '--changed',
      join(root, 'changed.json'),
      '--root',
      root,
    ]
    writeFileSync(join(root, 'apps/range.test.ts'), strong.replace('  expect(accepts(-1)).toBe(false)\n', ''))
    run(root, 'head.json')
    const weakened = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.equal(weakened.status, 1, weakened.stdout + weakened.stderr)
    assert.match(weakened.stderr, /branches .*below|branches regressed/)
    writeFileSync(join(root, 'apps/range.test.ts'), strong)
    writeFileSync(
      join(root, 'apps/unimported.mjs'),
      'export function missing(value) { return value ? 1 : 2 }',
    )
    const unimported = run(root, 'head.json')
    assert.equal(fileMetrics(unimported.files['apps/unimported.mjs']).functions.percent, 0)
    const missing = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.equal(missing.status, 1, missing.stdout + missing.stderr)
    assert.match(missing.stderr, /apps\/unimported.mjs: functions 0.00%/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('renaming runtime code to a test cannot remove it from the denominator', () => {
  const root = fixture()
  try {
    writeFileSync(join(root, 'apps/secret.test.ts'), code)
    writeFileSync(join(root, 'apps/range.ts'), "export { accepts } from './secret.test.ts'")
    assert.throws(() => inventory(root), /imports excluded test/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('workspace aliases and dynamic imports cannot smuggle excluded test code into production', () => {
  const root = fixture()
  try {
    mkdirSync(join(root, 'packages/example'), { recursive: true })
    writeFileSync(
      join(root, 'packages/example/package.json'),
      JSON.stringify({
        name: '@blockly/example',
        exports: { '.': './hidden.test.ts' },
      }),
    )
    writeFileSync(join(root, 'packages/example/hidden.test.ts'), code)
    writeFileSync(join(root, 'apps/range.ts'), "export { accepts } from '@blockly/example'")
    assert.throws(() => inventory(root), /imports excluded test packages\/example\/hidden.test.ts/)
    writeFileSync(join(root, 'apps/range.ts'), "export const load = () => import('@blockly/example')")
    assert.throws(() => inventory(root), /imports excluded test packages\/example\/hidden.test.ts/)
    for (const source of [
      "const target = '@blockly/example'; export const load = () => import(target)",
      `const prefix = '@blockly/'; const target = \`\${prefix}example\`; export const load = () => import(target)`,
      "const target = '@blockly/' + 'example'; export const load = () => require(target)",
    ]) {
      writeFileSync(join(root, 'apps/range.ts'), source)
      assert.throws(() => inventory(root), /imports excluded test packages\/example\/hidden.test.ts/)
    }
    writeFileSync(join(root, 'apps/range.ts'), 'export const load = (target) => import(target)')
    assert.throws(() => inventory(root), /Unresolved dynamic module import/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('instrumented application code keeps dependency CommonJS default exports intact', () => {
  const root = fixture()
  try {
    mkdirSync(join(root, 'node_modules/quality-cjs'), { recursive: true })
    writeFileSync(
      join(root, 'node_modules/quality-cjs/package.json'),
      JSON.stringify({
        name: 'quality-cjs',
        main: 'index.js',
      }),
    )
    writeFileSync(
      join(root, 'node_modules/quality-cjs/index.js'),
      `module.exports = class Validator {
      valid(value) { return value >= 0 && value <= 2 }
    }`,
    )
    writeFileSync(
      join(root, 'apps/range.ts'),
      `import Validator from 'quality-cjs'
export function accepts(value: number) { return new Validator().valid(value) }`,
    )
    const report = run(root, 'commonjs.json')
    assert.equal(fileMetrics(report.files['apps/range.ts']).functions.percent, 100)
    assert.ok(!Object.keys(report.files).some((path) => path.includes('node_modules')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('instrumentation preserves dependency error constructors and native stack capture', () => {
  const root = fixture()
  try {
    mkdirSync(join(root, 'node_modules/quality-errors'), { recursive: true })
    writeFileSync(
      join(root, 'node_modules/quality-errors/package.json'),
      JSON.stringify({
        name: 'quality-errors',
        main: 'index.js',
      }),
    )
    // This prototype-based Error shape is used by follow-redirects, loaded by the ACME client.
    // Babel's in-process stack formatter makes Bun reject its otherwise valid capture call.
    writeFileSync(
      join(root, 'node_modules/quality-errors/index.js'),
      `function DependencyError() {
      Error.captureStackTrace(this, this.constructor)
    }
    DependencyError.prototype = new Error('dependency error')
    const captured = new DependencyError()
    module.exports = class Validator {
      valid(value) { return captured instanceof Error && value >= 0 && value <= 2 }
    }`,
    )
    writeFileSync(
      join(root, 'apps/range.ts'),
      `import Validator from 'quality-errors'
export function accepts(value: number) { return new Validator().valid(value) }`,
    )
    const report = run(root, 'errors.json')
    assert.equal(fileMetrics(report.files['apps/range.ts']).functions.percent, 100)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
