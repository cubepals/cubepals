// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Mutation gate regressions: test-only changes, workspace imports, and false kill evidence. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { mutationEnvironment, mutationSnapshot, mutationVerdict } from './mutation.mjs'
import { readMutationJUnit } from './mutation-evidence.mjs'
import { rotationSubjects, selectMutationScope } from './mutation-scope.mjs'

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-scope-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

test('seven deterministic scheduled rotations are disjoint and cover the complete inventory', () => {
  const subjects = Array.from({ length: 200 }, (_, index) => `apps/source-${index}.ts`)
  const partitions = Array.from({ length: 7 }, (_, rotation) => rotationSubjects(subjects, rotation))
  assert.deepEqual([...partitions.flat()].sort(), [...subjects].sort())
  assert.equal(new Set(partitions.flat()).size, subjects.length)
  for (let rotation = 0; rotation < 7; rotation++)
    assert.deepEqual(rotationSubjects(subjects, rotation), partitions[rotation])
  assert.throws(() => rotationSubjects(subjects, 7), /Rotation/)
  assert.throws(() => rotationSubjects(subjects, -1), /Rotation/)
  assert.throws(() => rotationSubjects(subjects, 0.5), /Rotation/)
})

test('disposable snapshots preserve workspace links, nested tool installs and local Git queries', (t) => {
  const root = fixture(t, {
    '.gitignore': 'node_modules/\n',
    'package.json': '{"private":true}',
    'packages/probe/package.json': '{"name":"@blockly/probe"}',
    'packages/probe/src/value.ts': 'export const value = 1',
    'tools/openapi/package.json': '{"private":true}',
  })
  mkdirSync(join(root, 'node_modules/@blockly'), { recursive: true })
  symlinkSync('../../packages/probe', join(root, 'node_modules/@blockly/probe'))
  mkdirSync(join(root, 'tools/openapi/node_modules/dep'), { recursive: true })
  writeFileSync(join(root, 'tools/openapi/node_modules/dep/index.js'), 'export const value = 1')
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  const snapshot = mutationSnapshot(root)
  t.after(() => rmSync(snapshot, { recursive: true, force: true }))
  assert.equal(realpathSync(join(snapshot, 'node_modules/@blockly/probe')), join(snapshot, 'packages/probe'))
  assert.equal(
    realpathSync(join(snapshot, 'tools/openapi/node_modules/dep')),
    join(root, 'tools/openapi/node_modules/dep'),
  )
  assert.match(
    execFileSync('git', ['ls-files'], { cwd: snapshot, encoding: 'utf8' }),
    /packages\/probe\/src\/value.ts/,
  )
  assert.match(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: snapshot, encoding: 'utf8' }),
    /^[a-f\d]{40}\n$/,
  )
  assert.equal(execFileSync('git', ['remote', '-v'], { cwd: snapshot, encoding: 'utf8' }), '')
})

test('changing only a test mutates the production source behind a re-export and workspace alias', (t) => {
  const root = fixture(t, {
    'packages/probe/package.json': JSON.stringify({ name: '@blockly/probe', exports: './src/index.ts' }),
    'packages/probe/src/index.ts': "export { answer } from './answer.js'",
    'packages/probe/src/answer.ts': 'export const answer = () => 42',
    'apps/probe.test.ts': "import {answer} from '@blockly/probe'; answer()",
  })
  const scope = selectMutationScope({
    root,
    productionFiles: ['packages/probe/src/index.ts', 'packages/probe/src/answer.ts'],
    testFiles: ['apps/probe.test.ts'],
    changedFiles: ['apps/probe.test.ts'],
  })
  assert.deepEqual(scope.subjects, ['packages/probe/src/answer.ts', 'packages/probe/src/index.ts'])
  assert.deepEqual(scope.testsByFile['packages/probe/src/answer.ts'], ['apps/probe.test.ts'])
})

test('removed tests and unresolved dynamic imports force the full inventory', (t) => {
  const root = fixture(t, {
    'apps/a.ts': 'export const a = () => import(globalThis.path)',
    'apps/b.ts': 'export const b = () => 3',
    'apps/a.test.ts': "import {a} from './a'; a()",
  })
  const input = { root, productionFiles: ['apps/a.ts', 'apps/b.ts'], testFiles: ['apps/a.test.ts'] }
  for (const changedFiles of [['apps/a.ts'], ['apps/deleted.test.ts']]) {
    const scope = selectMutationScope({ ...input, changedFiles })
    assert.equal(scope.full, true)
    assert.deepEqual(scope.subjects, input.productionFiles)
  }
})

test('reassigned or shadowed dynamic import bindings never narrow mutation scope', (t) => {
  for (const source of [
    "let target = './a'; target = './b'; export const load = () => import(target)",
    "const target = './a'; export const load = (target: string) => import(target)",
  ]) {
    const root = fixture(t, {
      'apps/load.ts': source,
      'apps/a.ts': 'export const a = 1',
      'apps/b.ts': 'export const b = 2',
    })
    const files = ['apps/a.ts', 'apps/b.ts', 'apps/load.ts']
    const scope = selectMutationScope({
      root,
      productionFiles: files,
      testFiles: [],
      changedFiles: ['apps/load.ts'],
    })
    assert.equal(scope.full, true)
    assert.deepEqual(scope.subjects, files)
  }
})

test('an added source with no tests remains in scope; a test with no source cannot pass empty', (t) => {
  const root = fixture(t, { 'apps/a.ts': 'export const a = () => 1', 'apps/a.test.ts': 'const ok = true' })
  const input = { root, productionFiles: ['apps/a.ts'], testFiles: ['apps/a.test.ts'] }
  const scope = selectMutationScope({ ...input, changedFiles: ['apps/a.ts'] })
  assert.deepEqual(scope.subjects, ['apps/a.ts'])
  assert.deepEqual(scope.testsByFile['apps/a.ts'], [])
  assert.throws(
    () => selectMutationScope({ ...input, changedFiles: ['apps/a.test.ts'] }),
    /empty mutation run/,
  )
})

test('a full scan cannot pass with an empty source inventory', (t) => {
  const root = fixture(t, {})
  assert.throws(
    () => selectMutationScope({ root, productionFiles: [], testFiles: [], changedFiles: [], full: true }),
    /inventory is empty/,
  )
})

test('protected gate self-tests do not look like removed application tests', (t) => {
  const root = fixture(t, { 'apps/a.ts': 'export const a = () => 1' })
  const scope = selectMutationScope({
    root,
    productionFiles: ['apps/a.ts'],
    testFiles: [],
    changedFiles: ['scripts/quality/mutation.test.mjs', 'tools/quality/tool.test.mjs'],
  })
  assert.equal(scope.full, false)
  assert.deepEqual(scope.subjects, [])
})

test('only proved config-only changes avoid a full production scan', (t) => {
  const root = fixture(t, {
    'apps/a.ts': 'export const a = () => 1',
    'apps/b.ts': 'export const b = () => 2',
  })
  const input = {
    root,
    productionFiles: ['apps/a.ts', 'apps/b.ts'],
    testFiles: [],
    changedFiles: ['apps/a.ts', 'package.json'],
  }
  assert.equal(selectMutationScope(input).full, true)
  assert.deepEqual(
    selectMutationScope({ ...input, ignoredConfigFiles: new Set(['package.json']) }).subjects,
    ['apps/a.ts'],
  )
  assert.deepEqual(
    selectMutationScope({ ...input, changedFiles: ['apps/a.ts', 'tools/quality/package.json'] }).subjects,
    ['apps/a.ts'],
  )
})

test('per-file thresholds cannot be hidden by a stronger neighboring file', () => {
  const report = {
    files: {
      'a.ts': { mutants: [{ id: '0', status: 'Killed' }] },
      'b.ts': { mutants: [{ id: '1', status: 'Survived' }] },
    },
  }
  const verdict = mutationVerdict(report, ['a.ts', 'b.ts'])
  assert.equal(verdict.passed, false)
  assert.equal(verdict.files[0].score, 100)
  assert.equal(verdict.files[1].score, 0)
})

test('duplicated detections and unexpected source reports cannot inflate mutation evidence', () => {
  assert.throws(
    () =>
      mutationVerdict(
        {
          files: {
            'a.ts': {
              mutants: [
                { id: '0', status: 'Killed' },
                { id: '0', status: 'Killed' },
              ],
            },
          },
        },
        ['a.ts'],
      ),
    /duplicate mutant identity/,
  )
  assert.throws(
    () => mutationVerdict({ files: { 'a.ts': { mutants: [{ status: 'Killed' }] } } }, ['a.ts']),
    /mutant identity/,
  )
  assert.throws(
    () =>
      mutationVerdict(
        { files: { 'a.ts': { mutants: [{ id: '0', status: 'Killed' }] }, 'hidden.ts': { mutants: [] } } },
        ['a.ts'],
      ),
    /unexpected source file/,
  )
})

test('timeouts and tool errors receive no kill credit, while missing or ignored evidence fails closed', () => {
  for (const status of ['Ignored', 'Pending']) {
    assert.throws(
      () => mutationVerdict({ files: { 'a.ts': { mutants: [{ id: '0', status }] } } }, ['a.ts']),
      /untested/,
    )
  }
  assert.throws(() => mutationVerdict({ files: {} }, ['a.ts']), /No mutation evidence/)
  const report = { files: { 'a.ts': { mutants: [{ id: '0', status: 'Killed' }] } } }
  assert.throws(() => mutationVerdict(report, ['a.ts'], { evidence: {} }), /valid test evidence/)
  for (const status of ['Timeout', 'CompileError', 'RuntimeError'])
    assert.equal(
      mutationVerdict({ files: { 'a.ts': { mutants: [{ id: '0', status }] } } }, ['a.ts']).files[0].score,
      0,
    )
  const verdict = mutationVerdict(report, ['a.ts'], {
    evidence: { 0: { status: 'runner-error', passed: 0, failed: 0, skipped: 0 } },
  })
  assert.equal(verdict.files[0].killed, 0)
  assert.equal(verdict.files[0].inconclusive, 1)
  assert.equal(verdict.files[0].score, 0)
})

test('80 percent requires four proved kills even when Stryker calls a timed-out fifth mutant killed', () => {
  const mutants = Array.from({ length: 5 }, (_, index) => ({ id: String(index), status: 'Killed' }))
  const evidence = Object.fromEntries(
    mutants.map((mutant, index) => [
      mutant.id,
      index === 4
        ? { status: 'timeout', passed: 0, failed: 0, skipped: 0 }
        : { status: 'test-failure', passed: 0, failed: 1, skipped: 0 },
    ]),
  )
  const verdict = mutationVerdict({ files: { 'a.ts': { mutants } } }, ['a.ts'], { evidence })
  assert.equal(verdict.files[0].score, 80)
  assert.equal(verdict.files[0].inconclusive, 1)
  assert.equal(verdict.passed, true)
})

test('deployment secrets are not inherited by mutation tests', () => {
  assert.deepEqual(
    mutationEnvironment({
      PATH: '/bin',
      DATABASE_URL: 'local',
      FLY_API_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      NODE_OPTIONS: '--import=untrusted',
      COVERAGE_IGNORE: '*',
    }),
    { PATH: '/bin', DATABASE_URL: 'local' },
  )
})

test('zero mutants requires independent instrumenter evidence; missing generated mutants fail', () => {
  assert.throws(() => mutationVerdict({ files: {} }, ['a.ts']), /No mutation evidence/)
  const noExpressions = mutationVerdict({ files: {} }, ['a.ts'], {
    candidates: { 'a.ts': { count: 0, sha256: 'source-hash' } },
  })
  assert.equal(noExpressions.files[0].score, null)
  assert.equal(noExpressions.files[0].sha256, 'source-hash')
  assert.throws(
    () =>
      mutationVerdict({ files: { 'a.ts': { mutants: [{ id: '0', status: 'Killed' }] } } }, ['a.ts'], {
        candidates: { 'a.ts': { count: 2 } },
      }),
    /omitted candidates/,
  )
})

test('mutation evidence requires every file and rejects arbitrary skipped cases and malformed XML', () => {
  const xml = '<testsuites><testsuite file="a.test.ts"><testcase name="result"/></testsuite></testsuites>'
  assert.equal(readMutationJUnit(xml, ['a.test.ts']).passed, 1)
  const nested =
    '<testsuites><testsuite file="a.test.ts"><testsuite name="contract"><testcase name="result"/></testsuite></testsuite></testsuites>'
  assert.equal(readMutationJUnit(nested, ['a.test.ts']).passed, 1)
  assert.throws(() => readMutationJUnit(xml, ['a.test.ts', 'b.test.ts']), /did not report/)
  assert.throws(() => readMutationJUnit('<testsuites>', ['a.test.ts']), /Malformed/)
  assert.throws(
    () =>
      readMutationJUnit(
        xml.replace('<testcase name="result"/>', '<testcase name="result"><skipped/></testcase>'),
        ['a.test.ts'],
      ),
    /Unexpected skipped/,
  )
})

test('even an otherwise killed mutant fails if its skipped test identities changed', () => {
  const report = { files: { 'a.ts': { mutants: [{ id: '0', status: 'Killed' }] } } }
  assert.throws(
    () =>
      mutationVerdict(report, ['a.ts'], {
        evidence: {
          baseline: { status: 'passed', passed: 1, failed: 0, skipped: 0, skippedTests: [] },
          0: { status: 'test-failure', passed: 0, failed: 1, skipped: 1, skippedTests: ['new skip'] },
        },
      }),
    /valid test evidence/,
  )
})
