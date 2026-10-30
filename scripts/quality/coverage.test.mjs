// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The evidence parser is a gate, so malformed and incomplete reports must reject a change rather
 * than erase its denominator. These tests exercise report merging, missing counters, per-file
 * floors, measured-base regressions and zero-hit modules the test process never imported.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkCoverage, fileMetrics, mergeReports, validateReport } from './coverage.mjs'
import { classifySource, fileHash, parseSource, runtimeImports } from './inventory.mjs'
import { createInstrumenter } from './toolchain.mjs'

const path = 'apps/example.ts'
const source = `export function bounded(value: number) {
  if (value < 0) return 0
  return value
}`

function evidence(shard = 'one') {
  const instrumenter = createInstrumenter({ esModules: true, parserPlugins: ['typescript'] })
  instrumenter.instrumentSync(source, path)
  return {
    version: 1,
    shards: [shard],
    inventory: [{ path, sha256: fileHash(source), kind: 'source' }],
    files: { [path]: structuredClone(instrumenter.lastFileCoverage()) },
  }
}

function covered(shard = 'one') {
  const report = evidence(shard)
  const file = report.files[path]
  for (const key of Object.keys(file.s)) file.s[key] = 1
  for (const key of Object.keys(file.f)) file.f[key] = 1
  for (const values of Object.values(file.b)) values.fill(1)
  return report
}

test('raw TypeScript generics and JSX parse without erasing source locations', () => {
  assert.equal(parseSource('export const id = <T>(x: T): T => x', path).program.body.length, 1)
  assert.equal(classifySource('export const View = () => <main />', 'apps/view.tsx'), 'source')
  assert.equal(classifySource('export interface T { value: number }', path), 'declaration')
  assert.equal(classifySource('export type T = number; export {}', path), 'declaration')
  assert.equal(classifySource('declare const value: number', 'apps/types.d.ts'), 'declaration')
  assert.throws(() => classifySource('export const value = 1', 'apps/types.d.ts'), /executable code/)
})

test('generated code and test support are classified by executable content', () => {
  assert.equal(classifySource(source, 'apps/generated/schema.ts'), 'source')
  assert.equal(classifySource(source, 'apps/testing/provider.ts'), 'source')
  assert.equal(classifySource(source, 'apps/behavior.test.ts'), 'test')
  assert.equal(classifySource('export const label = "istanbul ignore next"', path), 'source')
  assert.throws(() => classifySource(`/* istanbul ignore file */\n${source}`, path), /suppression/)
})

test('never imported files retain zero-hit branch, function and line denominators', () => {
  const report = evidence()
  assert.equal(validateReport(report), report)
  const metrics = fileMetrics(report.files[path])
  for (const metric of Object.values(metrics)) {
    assert.ok(metric.total > 0)
    assert.equal(metric.covered, 0)
    assert.equal(metric.percent, 0)
  }
  const result = checkCoverage(report, report, [path])
  assert.equal(result.failures.length, 3)
})

test('missing source evidence and missing branch counters fail closed', () => {
  const noFile = evidence()
  delete noFile.files[path]
  assert.throws(() => validateReport(noFile), /exactly match/)
  const noBranches = evidence()
  delete noBranches.files[path].b
  assert.throws(() => validateReport(noBranches), /branches counters/)
  const missingArm = evidence()
  Object.values(missingArm.files[path].b)[0].pop()
  assert.throws(() => validateReport(missingArm), /branch arms/)
  assert.throws(() => validateReport({ version: 1, files: {} }), /inventory/)
})

test('counter corruption cannot masquerade as coverage', () => {
  for (const invalid of [-1, null, '1', Number.NaN, Number.POSITIVE_INFINITY]) {
    const report = evidence()
    report.files[path].s['0'] = invalid
    assert.throws(() => validateReport(report), /counter/)
  }
})

test('merging unions branch arms and rejects missing, duplicate or mismatched shards', () => {
  const one = evidence('one')
  const two = evidence('two')
  const key = Object.keys(one.files[path].b)[0]
  one.files[path].b[key][0] = 1
  two.files[path].b[key][1] = 1
  assert.equal(fileMetrics(mergeReports([one, two], 2).files[path]).branches.percent, 100)
  assert.throws(() => mergeReports([one], 2), /distinct shards/)
  assert.throws(() => mergeReports([one, one], 2), /distinct shards/)
  assert.throws(() => mergeReports([], 0), /No coverage/)
  two.inventory[0].sha256 = 'f'.repeat(64)
  assert.throws(() => mergeReports([one, two], 2), /different source/)
})

test('a new unimported file fails even if omitted from a supplied changed list', () => {
  const base = covered()
  const head = covered()
  const added = evidence().files[path]
  added.path = 'apps/new.ts'
  head.inventory.push({ path: added.path, sha256: fileHash('new'), kind: 'source' })
  head.files[added.path] = added
  const result = checkCoverage(head, base, [])
  assert.equal(result.failures.length, 3)
  assert.ok(result.failures.every((failure) => failure.startsWith('apps/new.ts:')))
})

test('unmodified legacy deficits are visible and any measured regression fails', () => {
  const zero = evidence()
  const legacy = checkCoverage(zero, zero, [])
  assert.equal(legacy.failures.length, 0)
  assert.equal(legacy.legacyDeficits.length, 3)
  assert.equal(checkCoverage(zero, covered(), []).failures.length, 6)
  assert.equal(checkCoverage(covered(), covered(), [path]).failures.length, 0)
})

test('head source hashes and current checkout inventory prevent stale evidence', () => {
  const base = evidence()
  const head = evidence()
  head.inventory[0].sha256 = fileHash(`${source}\n`)
  assert.equal(checkCoverage(head, base, []).failures.length, 3)
  assert.throws(() => checkCoverage(head, base, [], base.inventory), /current checkout/)
})

test('padding covered branches cannot hide an increase in uncovered branches', () => {
  const base = evidence()
  const head = evidence()
  const baseFile = base.files[path]
  const headFile = head.files[path]
  baseFile.b['0'] = [1, 0]
  headFile.b['0'] = [1, 0]
  headFile.branchMap['1'] = structuredClone(headFile.branchMap['0'])
  headFile.b['1'] = [1, 0]
  head.inventory[0].sha256 = fileHash('another partly covered branch')
  const result = checkCoverage(head, base, [])
  assert.equal(fileMetrics(baseFile).branches.percent, fileMetrics(headFile).branches.percent)
  assert.ok(result.failures.some((failure) => failure.includes('uncovered branches increased from 1 to 2')))
})

test('dynamic imports resolve immutable aliases and refuse ambiguous or mutable paths', () => {
  const imports = runtimeImports(
    parseSource(
      `const prefix = './'; const name = 'logic.test.ts'
    const target = prefix + name; export const load = () => import(target)`,
      path,
    ),
  )
  assert.deepEqual(imports, ['./logic.test.ts'])
  assert.deepEqual(runtimeImports(parseSource('const target = `mineflayer`; import(target)', path)), [
    'mineflayer',
  ])
  for (const source of [
    "let target = './logic.test.ts'; import(target)",
    "const target = 'external'; export function load(target) { return import(target) }",
    'export const load = () => import(globalThis.path)',
    'const first = second; const second = first; import(first)',
  ])
    assert.throws(() => runtimeImports(parseSource(source, path)), /Unresolved dynamic/)
})

test('freshness ignores separately guarded infrastructure but still rejects stale test evidence', () => {
  const report = covered()
  report.inventory.push({
    path: 'scripts/quality/runner.mjs',
    kind: 'infrastructure',
    sha256: fileHash('before'),
  })
  const current = structuredClone(report.inventory)
  current[1].sha256 = fileHash('after')
  assert.equal(checkCoverage(report, report, [], current).failures.length, 0)
  report.inventory.push({ path: 'apps/example.test.ts', kind: 'test', sha256: fileHash('old test') })
  current.push({ path: 'apps/example.test.ts', kind: 'test', sha256: fileHash('changed test') })
  assert.throws(() => checkCoverage(report, report, [], current), /current checkout/)
})
