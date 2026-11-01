// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Execution evidence changes mutation scheduling, never its subjects or retained test set. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { inventory } from './inventory.mjs'
import { executionProfile, orderMutationTests, recordExecution } from './mutation-test-order.mjs'
import { groupOf } from './shards.mjs'
import { createInstrumenter } from './toolchain.mjs'

const subject = 'apps/source.ts'
const direct = 'apps/direct.test.ts'
const imported = 'apps/imported.test.ts'
const unknown = 'apps/edge/unknown.test.ts'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const hit = (functions, branches = 0, statements = 0) => ({ functions, branches, statements })

function setup(paths = [direct, imported, unknown]) {
  const entries = [
    { path: subject, kind: 'source', sha256: hash(subject) },
    ...paths.map((path) => ({ path, kind: 'test', sha256: hash(path) })),
  ]
  const prepared = {
    inventory: entries,
    tests: entries.filter((entry) => entry.kind === 'test' && groupOf(entry.path) === 'rest'),
  }
  const profile = executionProfile(prepared, 'rest')
  for (const row of Object.values(profile.tests)) row.files = {}
  const scope = {
    subjects: [subject],
    testsByFile: { [subject]: [imported] },
    additionalTestsByFile: { [subject]: [paths.filter((path) => path !== imported)] },
    full: false,
    reasons: ['existing test edited'],
    changedFiles: [direct],
    testImpact: { verified: true },
    baseScore: null,
  }
  return { entries, profile, scope }
}

const retained = (scope) => [...scope.testsByFile[subject], ...scope.additionalTestsByFile[subject].flat()]

test('a test that actually executes the subject runs before a shared-harness import', () => {
  const { entries, profile, scope } = setup()
  profile.tests[direct].files[subject] = hit(2, 4, 8)
  const before = structuredClone(scope)
  const ordered = orderMutationTests(scope, profile, entries, 'rest')
  assert.deepEqual(ordered.testsByFile[subject], [direct])
  assert.deepEqual(ordered.additionalTestsByFile[subject], [[unknown], [imported]])
  assert.deepEqual(retained(ordered).sort(), retained(scope).sort())
  for (const key of ['subjects', 'full', 'reasons', 'changedFiles', 'testImpact', 'baseScore'])
    assert.deepEqual(ordered[key], scope[key])
  assert.deepEqual(scope, before)
})

test('distinct executed functions and branches rank ahead of repeated module initialization', () => {
  const { entries, profile, scope } = setup()
  profile.tests[direct].files[subject] = hit(3, 2, 4)
  profile.tests[imported].files[subject] = hit(1, 10, 100)
  assert.deepEqual(orderMutationTests(scope, profile, entries, 'rest').testsByFile[subject], [direct])
  profile.tests[imported].files[subject] = hit(3, 3, 4)
  assert.deepEqual(orderMutationTests(scope, profile, entries, 'rest').testsByFile[subject], [imported])
})

test('equal execution evidence preserves the original scheduling order', () => {
  const { entries, profile, scope } = setup()
  for (const row of Object.values(profile.tests)) row.files[subject] = hit(2, 3, 4)
  assert.deepEqual(orderMutationTests(scope, profile, entries, 'rest').testsByFile[subject], [imported])
})

test('equal construction coverage prefers the owning domain over unrelated harness tests', () => {
  const paths = ['apps/elsewhere/imported.test.ts', 'apps/source.test.ts']
  const { entries, profile, scope } = setup(paths)
  scope.testsByFile[subject] = [paths[0]]
  scope.additionalTestsByFile[subject] = [[paths[1]]]
  for (const row of Object.values(profile.tests)) row.files[subject] = hit(1, 0, 4)
  const ordered = orderMutationTests(scope, profile, entries, 'rest')
  assert.deepEqual(ordered.testsByFile[subject], [paths[1]])
  assert.deepEqual(retained(ordered).sort(), paths.sort())
})

test('an executing subject-owned suite precedes incidental higher-count integration coverage', () => {
  const paths = [imported, 'apps/source.test.ts']
  const { entries, profile, scope } = setup(paths)
  profile.tests[imported].files[subject] = hit(4, 12, 20)
  profile.tests[paths[1]].files[subject] = hit(3, 9, 15)
  const ordered = orderMutationTests(scope, profile, entries, 'rest')
  assert.deepEqual(ordered.testsByFile[subject], [paths[1]])
  assert.deepEqual(retained(ordered).sort(), paths.sort())
  assert.deepEqual(ordered.subjects, scope.subjects)
})

test('a service uses its domain suite before an incidental consumer', () => {
  const source = 'apps/control/src/app/revisions/service.ts'
  const paths = [
    'apps/control/src/app/backups/backups.test.ts',
    'apps/control/src/app/revisions/revisions.test.ts',
  ]
  const entries = [
    { path: source, kind: 'source', sha256: hash(source) },
    ...paths.map((path) => ({ path, kind: 'test', sha256: hash(path) })),
  ]
  const profile = executionProfile(
    { inventory: entries, tests: entries.filter((entry) => entry.kind === 'test') },
    'worlds',
  )
  profile.tests[paths[0]].files = { [source]: hit(16, 53, 85) }
  profile.tests[paths[1]].files = { [source]: hit(14, 79, 93) }
  const scope = {
    subjects: [source],
    testsByFile: { [source]: [paths[0]] },
    additionalTestsByFile: { [source]: [[paths[1]]] },
  }
  const ordered = orderMutationTests(scope, profile, entries, 'worlds')
  assert.deepEqual(ordered.testsByFile[source], [paths[1]])
  assert.deepEqual(
    [...ordered.testsByFile[source], ...ordered.additionalTestsByFile[source].flat()].sort(),
    paths.sort(),
  )
})

test('absent execution does not turn a static dependency into an exemption', () => {
  const { entries, profile, scope } = setup()
  assert.deepEqual(orderMutationTests(scope, profile, entries, 'rest'), scope)
})

test('dependency-only base and head oracle sets are not reordered', () => {
  const { entries, profile, scope } = setup()
  scope.baseScore = { subjects: [subject], oracleTests: [direct, imported] }
  profile.tests[direct].files[subject] = hit(1)
  assert.equal(orderMutationTests(scope, profile, entries, 'rest'), scope)
})

test('all candidates remain in bounded expansion batches', () => {
  const paths = [imported, ...Array.from({ length: 11 }, (_, i) => `apps/test-${i}.test.ts`)]
  const { entries, profile, scope } = setup(paths)
  for (const row of Object.values(profile.tests)) row.files[subject] = hit(1)
  const ordered = orderMutationTests(scope, profile, entries, 'rest')
  assert.deepEqual(retained(ordered).sort(), paths.sort())
  assert.ok(ordered.additionalTestsByFile[subject].every((batch) => batch.length > 0 && batch.length <= 4))
})

test('stale, foreign, incomplete and malformed execution profiles fail closed', () => {
  const { entries, profile, scope } = setup()
  for (const corrupt of [
    (p) => {
      p.version = 2
    },
    (p) => {
      p.group = 'mods'
    },
    (p) => {
      p.sources = []
    },
    (p) => {
      p.tests = []
    },
    (p) => {
      delete p.sources[subject]
    },
    (p) => {
      p.sources[subject] = hash('changed')
    },
    (p) => {
      delete p.tests[direct]
    },
    (p) => {
      p.tests[direct].sha256 = hash('changed test')
    },
    (p) => {
      p.tests[direct].files = null
    },
    (p) => {
      p.tests[direct].files['apps/foreign.ts'] = hit(1)
    },
    (p) => {
      p.tests[direct].files[subject] = hit(-1)
    },
    (p) => {
      p.tests[direct].files[subject] = hit(Number.NaN)
    },
    (p) => {
      p.tests[direct].files[subject] = { functions: 1 }
    },
  ]) {
    const stale = structuredClone(profile)
    corrupt(stale)
    assert.throws(() => orderMutationTests(scope, stale, entries, 'rest'))
  }
})

test('duplicate static candidates cannot be silently lost', () => {
  const { entries, profile, scope } = setup()
  scope.additionalTestsByFile[subject].push([imported])
  assert.throws(() => orderMutationTests(scope, profile, entries, 'rest'), /Duplicate mutation test/)
})

test('recording uses real Istanbul counter shapes and counts distinct covered locations', () => {
  const { entries } = setup([direct])
  const prepared = { inventory: entries, tests: entries.filter((entry) => entry.kind === 'test') }
  const profile = executionProfile(prepared, 'rest')
  const instrumenter = createInstrumenter()
  instrumenter.instrumentSync('export function value(flag) { if (flag) return 1; return 2 }', subject)
  const file = structuredClone(instrumenter.lastFileCoverage())
  for (const metric of ['s', 'f']) for (const key of Object.keys(file[metric])) file[metric][key] = 100
  for (const arms of Object.values(file.b)) arms.fill(100)
  const fragment = { test: prepared.tests[0], files: { [subject]: file } }
  recordExecution(profile, [fragment])
  assert.deepEqual(profile.tests[direct].files[subject], {
    statements: Object.keys(file.s).length,
    functions: Object.keys(file.f).length,
    branches: Object.values(file.b).flat().length,
  })
  assert.throws(() => recordExecution(profile, [fragment]), /duplicate/)
})

test('real isolated Bun runs identify the exercising test despite a shared import', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-test-order-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    [subject]: 'export function value() { return 7 }',
    'apps/harness.ts': "export { value } from './source.ts'",
    [direct]:
      "import {test,expect} from 'bun:test'; import {value} from './harness.ts'; test('value',()=>expect(value()).toBe(7))",
    [imported]:
      "import {test,expect} from 'bun:test'; import './harness.ts'; test('imports',()=>expect(true).toBe(true))",
  }
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  const output = join(root, 'coverage/head')
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./run-shard.mjs', import.meta.url)), root, 'rest', output],
    {
      encoding: 'utf8',
      timeout: 90 * SECOND_MS,
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://fixture.invalid/unused',
        NATS_TEST_URL: 'nats://fixture.invalid',
        S3_TEST_ENDPOINT: 'http://fixture.invalid',
        S3_TEST_BUCKET: 'unused',
        PEBBLE_TEST_URL: 'https://fixture.invalid',
        CHALLTESTSRV_TEST_URL: 'http://fixture.invalid',
      },
    },
  )
  assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stdout}\n${run.stderr}`)
  const profile = JSON.parse(readFileSync(join(output, 'test-execution/rest.json'), 'utf8'))
  const { scope } = setup([direct, imported])
  const ordered = orderMutationTests(scope, profile, inventory(root), 'rest')
  assert.deepEqual(ordered.testsByFile[subject], [direct])
  assert.deepEqual(retained(ordered).sort(), [direct, imported].sort())
})
