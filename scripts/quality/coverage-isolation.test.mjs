// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Proves isolated test processes preserve the union of real branch counters without retaining
 * globals, mocks or environment mutations. Trusted collection rejects incomplete fragments and
 * changed inputs, and runs unchanged tests before later additions can affect their evidence.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { fileMetrics, validateReport } from './coverage.mjs'
import { mergeFragments } from './coverage-fragments.mjs'
import { assertInputsUnchanged, partitionTests, snapshotInputs } from './coverage-inputs.mjs'
import { checkJUnit } from './coverage-junit.mjs'
import { liveFleet } from './evidence-policy.mjs'
import { fileHash } from './inventory.mjs'
import { createInstrumenter, XMLParser } from './toolchain.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const bun = process.env.QUALITY_BUN ?? 'bun'
const source = `function sign(value) {
  if (value < 0) return -1
  if (value > 0) return 1
  return 0
}`

function counters() {
  const path = 'apps/subject.ts'
  const instrumenter = createInstrumenter({
    coverageVariable: '__qualityCoverage__',
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
    esModules: true,
    parserPlugins: ['typescript'],
  })
  const code = instrumenter.instrumentSync(source, path)
  const tests = ['negative', 'positive', 'zero'].map((name) => ({
    path: `apps/${name}.test.ts`,
    sha256: fileHash(name),
  }))
  const prepared = {
    version: 2,
    root: '/fixture',
    runId: randomUUID(),
    inventory: [
      { path, sha256: fileHash(source), kind: 'source' },
      ...tests.map((entry) => ({ ...entry, kind: 'test' })),
    ],
    tests,
    templates: { [path]: structuredClone(instrumenter.lastFileCoverage()) },
    contents: { [path]: code },
  }
  const options = { preparedSha256: fileHash(JSON.stringify(prepared)), phase: 'all' }
  const fragments = [-1, 1, 0].map((value, index) => ({
    version: 1,
    runId: prepared.runId,
    ...options,
    test: tests[index],
    files: structuredClone(runInNewContext(`${code}\nsign(${value}); globalThis.__qualityCoverage__`, {})),
  }))
  return { prepared, fragments, expected: tests.map((entry) => entry.path), options }
}

function merge(fixture) {
  return mergeFragments(fixture.prepared, fixture.fragments, fixture.expected, fixture.options)
}

test('isolated fragments preserve each real branch and sum function invocations', () => {
  const fixture = counters()
  const report = merge(fixture)
  const file = report.files['apps/subject.ts']
  assert.deepEqual(file.b, { 0: [1, 2], 1: [1, 1] })
  assert.deepEqual(file.f, { 0: 3 })
  assert.equal(fileMetrics(file).branches.percent, 100)
  assert.equal(fixture.prepared.templates['apps/subject.ts'].f[0], 0)
})

test('an unimported source remains present with zero counters in sparse fragments', () => {
  const fixture = counters()
  for (const fragment of fixture.fragments) fragment.files = {}
  const report = merge(fixture)
  assert.equal(fileMetrics(report.files['apps/subject.ts']).functions.percent, 0)
  assert.equal(fileMetrics(report.files['apps/subject.ts']).branches.percent, 0)
})

const invalidFragments = {
  missing: ({ fragments }) => fragments.pop(),
  duplicate: ({ fragments }) => fragments.push(structuredClone(fragments[0])),
  'foreign test': ({ fragments }) => {
    fragments[0].test = { ...fragments[0].test, path: 'apps/foreign.test.ts' }
  },
  'stale test bytes': ({ fragments }) => {
    fragments[0].test = { ...fragments[0].test, sha256: fileHash('changed test') }
  },
  'foreign run': ({ fragments }) => {
    fragments[0].runId = randomUUID()
  },
  'foreign prepared digest': ({ fragments }) => {
    fragments[0].preparedSha256 = fileHash('other prepared manifest')
  },
  'foreign phase': ({ fragments }) => {
    fragments[0].phase = 'changed'
  },
  'foreign source': ({ fragments }) => {
    fragments[0].files['apps/foreign.ts'] = fragments[0].files['apps/subject.ts']
  },
  'negative counter': ({ fragments }) => {
    fragments[0].files['apps/subject.ts'].f[0] = -1
  },
  'unsafe counter': ({ fragments }) => {
    fragments[0].files['apps/subject.ts'].f[0] = Number.MAX_SAFE_INTEGER + 1
  },
  'missing branch arm': ({ fragments }) => {
    fragments[0].files['apps/subject.ts'].b[0].pop()
  },
  'removed map and matching counter': ({ fragments }) => {
    delete fragments[0].files['apps/subject.ts'].b[0]
    delete fragments[0].files['apps/subject.ts'].branchMap[0]
  },
  'changed source location': ({ fragments }) => {
    fragments[0].files['apps/subject.ts'].statementMap[0].start.line += 1
  },
}

for (const [name, invalidate] of Object.entries(invalidFragments)) {
  test(`fragment merge rejects ${name}`, () => {
    const fixture = counters()
    merge(fixture)
    invalidate(fixture)
    assert.throws(() => merge(fixture))
  })
}

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'quality-isolation-'))
  execFileSync('git', ['init', '--quiet', root])
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

function track(root) {
  execFileSync('git', ['add', '.'], { cwd: root })
}

const inputMutations = {
  source: (root) => write(root, 'apps/subject.ts', 'export const value = 2'),
  test: (root) => write(root, 'apps/subject.test.ts', '// erased test'),
  fixture: (root) => write(root, 'fixtures/reference.txt', 'changed reference'),
  deletion: (root) => rmSync(join(root, 'apps/subject.ts')),
  'new tracked input': (root) => {
    write(root, 'fixtures/new.txt', 'new input')
    track(root)
  },
}

for (const [name, mutate] of Object.entries(inputMutations)) {
  test(`input snapshot rejects changed ${name}`, (t) => {
    const root = repository(t)
    write(root, 'apps/subject.ts', 'export const value = 1')
    write(root, 'apps/subject.test.ts', '// existing test')
    write(root, 'fixtures/reference.txt', 'original reference')
    track(root)
    const before = snapshotInputs(root)
    assertInputsUnchanged(root, before)
    mutate(root)
    assert.throws(() => assertInputsUnchanged(root, before))
  })
}

test('input snapshots allow runtime output while protecting explicit untracked inputs', (t) => {
  const root = repository(t)
  write(root, 'apps/subject.ts', 'export const value = 1')
  track(root)
  write(root, 'apps/new.test.ts', '// new test')
  const before = snapshotInputs(root, ['apps/new.test.ts'])
  write(root, 'runtime-output.json', '{"result":1}')
  assertInputsUnchanged(root, before)
  write(root, 'apps/new.test.ts', '// changed during execution')
  assert.throws(() => assertInputsUnchanged(root, before), /modified an input/)
})

test('exact test bytes separate unchanged evidence from modified and added tests', () => {
  const tests = [
    { path: 'apps/a-added.test.ts', sha256: fileHash('added') },
    { path: 'apps/b-changed.test.ts', sha256: fileHash('changed') },
    { path: 'apps/z-original.test.ts', sha256: fileHash('original') },
  ]
  const base = {
    version: 1,
    tests: [tests[2], { ...tests[1], sha256: fileHash('previous version') }],
  }
  assert.deepEqual(partitionTests(tests, base), [
    { name: 'unchanged', tests: ['apps/z-original.test.ts'] },
    { name: 'changed', tests: ['apps/a-added.test.ts', 'apps/b-changed.test.ts'] },
  ])
  assert.deepEqual(partitionTests(tests), [{ name: 'all', tests: tests.map((entry) => entry.path) }])
  assert.throws(() => partitionTests(tests, { version: 1, tests: [tests[0], tests[0]] }))
  assert.throws(() => partitionTests(tests, { version: 1, tests: [{ ...tests[0], sha256: 'bad' }] }))
})

function run(root, reportDir, manifest, extraEnv = {}, group = 'rest') {
  const env = {
    ...process.env,
    DATABASE_URL: 'postgres://fixture.invalid/unused',
    NATS_TEST_URL: 'nats://fixture.invalid',
    S3_TEST_ENDPOINT: 'http://fixture.invalid',
    S3_TEST_BUCKET: 'unused',
    PEBBLE_TEST_URL: 'https://fixture.invalid',
    CHALLTESTSRV_TEST_URL: 'http://fixture.invalid',
    QUALITY_BUN: bun,
    ...extraEnv,
  }
  delete env.QUALITY_ISOLATION_SENTINEL
  return spawnSync(
    process.execPath,
    [join(here, 'run-shard.mjs'), root, group, reportDir, ...(manifest ? [manifest] : [])],
    { cwd: root, encoding: 'utf8', timeout: 90_000, env },
  )
}

function successful(result) {
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
}

function reportAt(reportDir, group = 'rest') {
  return validateReport(JSON.parse(readFileSync(join(reportDir, `${group}.json`), 'utf8')))
}

test('isolated shard retains the branch union and rejects deliberate removal of isolation', (t) => {
  const root = repository(t)
  write(root, 'apps/subject.ts', `export ${source}`)
  write(root, 'apps/dependency.ts', 'export const answer = () => 7; export const state = { value: 7 }')
  write(root, 'apps/unimported.ts', 'export function absent(value) { return value ? 1 : 2 }')
  write(
    root,
    'apps/01-negative.test.ts',
    `import { test, expect, mock } from 'bun:test'
import { sign } from './subject.ts'
import { state } from './dependency.ts'
test('negative branch with deliberate process pollution', () => {
  expect(sign(-1)).toBe(-1)
  globalThis.qualityPollution = 17
  process.env.QUALITY_ISOLATION_SENTINEL = 'leak'
  state.value = 17
  mock.module('./dependency.ts', () => ({ answer: () => 17, state: { value: 17 } }))
})`,
  )
  write(
    root,
    'apps/02-positive.test.ts',
    `import { test, expect } from 'bun:test'
import { sign } from './subject.ts'
import { answer, state } from './dependency.ts'
test('positive branch has independent state', () => {
  expect(globalThis.qualityPollution).toBeUndefined()
  expect(process.env.QUALITY_ISOLATION_SENTINEL).toBeUndefined()
  expect(answer()).toBe(7)
  expect(state.value).toBe(7)
  expect(sign(1)).toBe(1)
})`,
  )
  write(
    root,
    'apps/03-zero.test.ts',
    `import { test, expect } from 'bun:test'
import { sign } from './subject.ts'
test('zero branch has independent state', () => {
  expect(globalThis.qualityPollution).toBeUndefined()
  expect(process.env.QUALITY_ISOLATION_SENTINEL).toBeUndefined()
  expect(sign(0)).toBe(0)
})`,
  )
  track(root)
  const reportDir = join(root, 'reports')
  successful(run(root, reportDir))
  const report = reportAt(reportDir)
  assert.deepEqual(report.files['apps/subject.ts'].b, { 0: [1, 2], 1: [1, 1] })
  assert.deepEqual(report.files['apps/subject.ts'].f, { 0: 3 })
  assert.equal(fileMetrics(report.files['apps/unimported.ts']).functions.percent, 0)
  const manifest = JSON.parse(readFileSync(join(reportDir, 'manifests/rest.json'), 'utf8'))
  assert.deepEqual(manifest.tests.map((entry) => entry.path).sort(), [
    'apps/01-negative.test.ts',
    'apps/02-positive.test.ts',
    'apps/03-zero.test.ts',
  ])
  const defectiveBun = join(root, 'defective-bun.mjs')
  writeFileSync(
    defectiveBun,
    `#!${process.execPath}
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2).map((value) => value === '--isolate' ? '--no-isolate' : value)
const result = spawnSync(${JSON.stringify(bun)}, args, { stdio: 'inherit', env: process.env })
process.exit(result.status ?? 1)
`,
  )
  chmodSync(defectiveBun, 0o755)
  const rejectedDir = join(root, 'rejected-reports')
  const rejected = run(root, rejectedDir, undefined, { QUALITY_BUN: defectiveBun })
  assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr)
  assert.match(rejected.stderr, /qualityPollution|independent state|toBeUndefined/)
  assert.equal(existsSync(join(rejectedDir, 'rest.json')), false)
})

test('unchanged tests finish in a separate process before lexically earlier additions', (t) => {
  const root = repository(t)
  write(root, 'apps/subject.ts', `export ${source}`)
  const original = `import { test, expect } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { sign } from './subject.ts'
test('unchanged negative branch', () => {
  expect(existsSync('added-ran.json')).toBe(false)
  expect(sign(-1)).toBe(-1)
  writeFileSync('original-ran.json', JSON.stringify({ pid: process.pid }))
})`
  write(root, 'apps/z-original.test.ts', original)
  for (const [path, value] of [
    ['apps/a-added.test.ts', 1],
    ['apps/b-changed.test.ts', 0],
  ]) {
    write(
      root,
      path,
      `import { test, expect } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sign } from './subject.ts'
test('later branch runs after original evidence is complete', () => {
  const original = JSON.parse(readFileSync('original-ran.json', 'utf8'))
  expect(process.pid).not.toBe(original.pid)
  expect(existsSync(join(dirname(process.env.QUALITY_PARTS), 'unchanged'))).toBe(false)
  expect(sign(${value})).toBe(${value})
  writeFileSync('added-ran.json', 'true')
})`,
    )
  }
  track(root)
  const manifest = join(root, 'base-tests.json')
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      tests: [
        { path: 'apps/z-original.test.ts', sha256: fileHash(original) },
        { path: 'apps/b-changed.test.ts', sha256: fileHash('previous test contents') },
      ],
    }),
  )
  const reportDir = join(root, 'reports')
  successful(run(root, reportDir, manifest))
  const report = reportAt(reportDir)
  assert.deepEqual(report.files['apps/subject.ts'].b, { 0: [1, 2], 1: [1, 1] })
  assert.deepEqual(report.files['apps/subject.ts'].f, { 0: 3 })
})

test('a passing test cannot publish coverage after changing a tracked fixture', (t) => {
  const root = repository(t)
  write(root, 'apps/subject.ts', `export ${source}`)
  write(root, 'fixtures/reference.txt', 'original reference')
  write(
    root,
    'apps/tamper.test.ts',
    `import { test, expect } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { sign } from './subject.ts'
test('passing assertion followed by tracked input tampering', () => {
  expect(sign(0)).toBe(0)
  writeFileSync('fixtures/reference.txt', 'rewritten reference')
})`,
  )
  track(root)
  const reportDir = join(root, 'reports')
  const result = run(root, reportDir)
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stderr, /modified an input|input.*changed/)
  assert.equal(existsSync(join(reportDir, 'rest.json')), false)
})

test('an all-skipped optional fleet phase emits evidence before an executed provider phase', (t) => {
  const root = repository(t)
  const optionalPath = [...liveFleet][0]
  const providerDirectory = dirname(optionalPath)
  const ordinaryPath = `${providerDirectory}/local.test.ts`
  const sourcePath = `${providerDirectory}/subject.ts`
  write(root, sourcePath, `export ${source}`)
  const optional = `import { test, expect } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { sign } from './subject.ts'
writeFileSync('optional-loaded.json', JSON.stringify({ pid: process.pid }))
test.skip('real fleet requires separate daemon services', () => {
  expect(sign(-1)).toBe(-1)
})`
  write(root, optionalPath, optional)
  write(
    root,
    ordinaryPath,
    `import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { sign } from './subject.ts'
test('local provider runs after the optional phase', () => {
  const optional = JSON.parse(readFileSync('optional-loaded.json', 'utf8'))
  expect(process.pid).not.toBe(optional.pid)
  expect(sign(0)).toBe(0)
})`,
  )
  track(root)
  const manifest = join(root, 'base-tests.json')
  writeFileSync(
    manifest,
    JSON.stringify({ version: 1, tests: [{ path: optionalPath, sha256: fileHash(optional) }] }),
  )
  const reportDir = join(root, 'reports')
  const result = run(root, reportDir, manifest, {}, 'providers')
  successful(result)
  assert.match(result.stderr, /providers:unchanged: 1 isolated test files verified/)
  assert.match(result.stderr, /providers:changed: 1 isolated test files verified/)
  assert.deepEqual(reportAt(reportDir, 'providers').files[sourcePath].f, { 0: 1 })
  const xml = readFileSync(join(reportDir, 'providers.xml'), 'utf8')
  assert.equal(checkJUnit(xml, [optionalPath, ordinaryPath]), 1)
  const summary = new XMLParser({ ignoreAttributes: false }).parse(xml).testsuites
  assert.equal(Number(summary['@_tests']), 2)
  assert.equal(Number(summary['@_skipped']), 1)
  assert.equal(Number(summary['@_failures']), 0)
})

test('compiled cache tampering is rejected before a dynamic source import executes', (t) => {
  const root = repository(t)
  write(root, 'apps/subject.ts', `export ${source}`)
  write(
    root,
    'apps/cache-tamper.test.ts',
    `import { test, expect } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
test('cannot replace compiled source with fabricated behavior', async () => {
  const preparedPath = process.env.QUALITY_PREPARED
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'))
  const compiled = prepared.modules['apps/subject.ts']
  writeFileSync(join(dirname(preparedPath), 'compiled', compiled.file),
    'export function sign() { return 0 }')
  const { sign } = await import('./subject.ts')
  expect(sign(-1)).toBe(-1)
})`,
  )
  track(root)
  const reportDir = join(root, 'reports')
  const result = run(root, reportDir)
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stderr, /Compiled coverage source changed: apps\/subject.ts/)
  assert.equal(existsSync(join(reportDir, 'rest.json')), false)
})

test('a passing test cannot publish coverage after changing the runtime manifest', (t) => {
  const root = repository(t)
  write(root, 'apps/subject.ts', `export ${source}`)
  write(
    root,
    'apps/manifest-tamper.test.ts',
    `import { test, expect } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { sign } from './subject.ts'
test('passing assertion followed by runtime manifest tampering', () => {
  expect(sign(0)).toBe(0)
  const preparedPath = process.env.QUALITY_PREPARED
  writeFileSync(preparedPath, readFileSync(preparedPath, 'utf8') + '\\n')
})`,
  )
  track(root)
  const reportDir = join(root, 'reports')
  const result = run(root, reportDir)
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stderr, /1 pass/)
  assert.match(result.stderr, /modified the prepared coverage manifest/)
  assert.equal(existsSync(join(reportDir, 'rest.json')), false)
})
