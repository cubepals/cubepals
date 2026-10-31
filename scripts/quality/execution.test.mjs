// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Evidence cannot vanish behind a green aggregate, an empty test run, or a skipped scenario. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyJobs } from './aggregate.mjs'
import { inventory } from './inventory.mjs'
import { checkJUnit } from './run-shard.mjs'
import { groupOf, groups } from './shards.mjs'

const clean = () =>
  Object.fromEntries(
    ['changes', 'licenses', 'static', 'test', 'quality', 'worker', 'images', 'reporter', 'fleet'].map(
      (key) => [
        key,
        {
          result: 'success',
          ...(key === 'changes' ? { outputs: { code: 'true', reporter: 'true', fleet: 'true' } } : {}),
        },
      ],
    ),
  )

test('required CI rejects every non-success state, missing result and missing change output', () => {
  assert.equal(verifyJobs(clean()), true)
  for (const job of Object.keys(clean())) {
    for (const result of ['failure', 'skipped', 'cancelled', '']) {
      const needs = clean()
      needs[job].result = result
      assert.throws(() => verifyJobs(needs), /must succeed|expected/)
    }
    const needs = clean()
    delete needs[job]
    assert.throws(() => verifyJobs(needs), /Missing CI job/)
  }
  const needs = clean()
  delete needs.changes.outputs
  assert.throws(() => verifyJobs(needs), /Missing change classification/)
})

test('documentation-only changes still require licenses and permit only classified skips', () => {
  const needs = clean()
  needs.changes.outputs = { code: 'false', reporter: 'false', fleet: 'false' }
  for (const job of ['static', 'test', 'quality', 'worker', 'images', 'reporter', 'fleet'])
    needs[job].result = 'skipped'
  assert.equal(verifyJobs(needs), true)
  needs.licenses.result = 'skipped'
  assert.throws(() => verifyJobs(needs), /must succeed/)
})

test('Fleet can skip only when its own classification permits it', () => {
  const needs = clean()
  needs.changes.outputs.fleet = 'false'
  needs.fleet.result = 'skipped'
  assert.equal(verifyJobs(needs), true)
  for (const result of ['success', 'failure', 'cancelled']) {
    needs.fleet.result = result
    assert.throws(() => verifyJobs(needs), /fleet: expected skipped/)
  }
  for (const value of [undefined, '', true, 'unknown']) {
    needs.changes.outputs.fleet = value
    assert.throws(() => verifyJobs(needs), /Missing change classification/)
  }
  const prose = clean()
  prose.changes.outputs = { code: 'false', reporter: 'false', fleet: 'true' }
  for (const job of ['static', 'test', 'quality', 'worker', 'images', 'reporter'])
    prose[job].result = 'skipped'
  assert.equal(
    verifyJobs(prose),
    true,
    'conservative Fleet selection remains independent of prose classification',
  )
  prose.fleet.result = 'skipped'
  assert.throws(() => verifyJobs(prose), /fleet: expected success/)
})

test('the real aggregate CLI rejects absent, skipped or failed required Fleet work', () => {
  const controller = fileURLToPath(new URL('./aggregate.mjs', import.meta.url))
  for (const mode of ['failure', 'skipped', 'cancelled', 'missing', 'unclassified', 'detection-failed']) {
    const needs = clean()
    if (mode === 'missing') delete needs.fleet
    else if (mode === 'unclassified') delete needs.changes.outputs.fleet
    else if (mode === 'detection-failed') needs.changes.result = 'failure'
    else needs.fleet.result = mode
    const child = spawnSync(process.execPath, [controller], {
      env: { ...process.env, NEEDS: JSON.stringify(needs) },
      encoding: 'utf8',
    })
    assert.equal(child.status, 1, mode)
    assert.match(child.stderr, /fleet|Missing change classification|Change detection/)
  }
})

test('the actual Fleet classifier includes shared inputs without running for unrelated app source', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const section = workflow.match(/\n {12}fleet:\n((?: {14}- '[^']+'\n)+)/)?.[1]
  assert.ok(section, 'Fleet path classification must exist')
  const patterns = [...section.matchAll(/- '([^']+)'/g)].map((match) => match[1])
  const selected = (path) => patterns.some((pattern) => matchesGlob(path, pattern))
  for (const path of [
    'apps/control/src/infra/fleet/fleet-runtime.ts',
    'apps/control/src/testing/fleet.ts',
    'apps/control/Dockerfile',
    'packages/contracts/src/runtime.ts',
    'packages/db/migrations/new.sql',
    'scripts/blocklyd.ts',
    'scripts/quality/fleet-evidence.mjs',
    'tools/quality/package.json',
    'package.json',
    'apps/web/package.json',
    'bun.lock',
    'apps/edge/bunfig.toml',
    'bunfig.toml',
    'tsconfig.base.json',
    'apps/web/tsconfig.json',
    'runtime.config.mjs',
    '.node-version',
    '.npmrc',
    '.env.test',
    '.github/workflows/ci.yml',
    '.github/workflows/fleet.yml',
  ])
    assert.equal(selected(path), true, `${path} must require live Fleet evidence`)
  for (const path of [
    'apps/web/src/page.tsx',
    'apps/edge/index.ts',
    'apps/reporter/src/main/java/Example.java',
    'docs/fleet.md',
    'README.md',
  ])
    assert.equal(selected(path), false, `${path} is unrelated to the live Fleet runtime`)
  assert.match(
    workflow,
    /fleet: \$\{\{ .*merge_group.*schedule.*workflow_dispatch.*steps\.fleet\.outputs\.fleet/,
  )
  assert.match(
    workflow,
    /\n {2}fleet:\n {4}needs: changes\n {4}if: needs\.changes\.outputs\.fleet == 'true'\n {4}uses: \.\/\.github\/workflows\/fleet\.yml/,
  )
  assert.match(workflow, /\n {2}check:\n {4}needs: \[[^\]\n]*\bfleet\]/)
})

test('JUnit requires all selected files, executed cases and no unexpected skips', () => {
  const xml = (body) => `<testsuites><testsuite file="apps/edge/a.test.ts">${body}</testsuite></testsuites>`
  const files = ['apps/edge/a.test.ts']
  assert.equal(checkJUnit(xml('<testcase name="contract"/>'), files), 1)
  assert.throws(
    () => checkJUnit(xml('<testcase name="contract"><skipped/></testcase>'), files),
    /Unexpected skipped/,
  )
  assert.throws(
    () => checkJUnit(xml('<testcase name="contract"><failure/></testcase>'), files),
    /Failed test/,
  )
  assert.throws(() => checkJUnit(xml(''), files), /No tests executed/)
  assert.throws(
    () => checkJUnit(xml('<testcase name="contract"/>'), [...files, 'new.test.ts']),
    /did not report/,
  )
  assert.throws(() => checkJUnit(xml('<testcase/>'), files), /Invalid JUnit test case/)
  assert.throws(() => checkJUnit('<testsuites>', files), /Malformed/)
})

test('the shard remainder assigns new test paths and every known group is reachable', () => {
  for (const [group, prefixes] of Object.entries(groups)) {
    assert.equal(groupOf(`${prefixes[0] ?? 'packages/new/'}some.test.ts`), group)
  }
})

test('the access split preserves every actual source and test in exactly one partition', () => {
  const entries = inventory(fileURLToPath(new URL('../../', import.meta.url))).filter(
    ({ kind }) => kind === 'source' || kind === 'test',
  )
  const previous = Object.entries(groups).filter(([group]) => group !== 'access')
  const before = new Map(previous.map(([group]) => [group, []]))
  const after = new Map(Object.keys(groups).map((group) => [group, []]))
  for (const { path } of entries) {
    const matching = Object.entries(groups).filter(([, prefixes]) =>
      prefixes.some((prefix) => path.startsWith(prefix)),
    )
    assert.ok(matching.length <= 1, `Overlapping partitions: ${path}`)
    const oldGroup =
      previous.find(([, prefixes]) => prefixes.some((prefix) => path.startsWith(prefix)))?.[0] ?? 'rest'
    before.get(oldGroup).push(path)
    after.get(groupOf(path)).push(path)
  }
  assert.ok(after.get('access').length > 0, 'The new partition must carry actual evidence')
  assert.deepEqual([...after.get('rest'), ...after.get('access')].sort(), before.get('rest').sort())
  for (const [group, paths] of before) {
    if (group !== 'rest') assert.deepEqual(after.get(group), paths)
  }
  assert.equal(new Set([...after.values()].flat()).size, entries.length)
})

test('the workflow schedules every partition and requires the same number of evidence shards', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const matrix = [...workflow.matchAll(/^\s+quality: ([a-z]+)$/gm)].map((match) => match[1])
  assert.deepEqual(matrix.sort(), Object.keys(groups).sort())
  const counts = [...workflow.matchAll(/--expected-shards (\d+)/g)].map((match) => Number(match[1]))
  assert.deepEqual(counts, [matrix.length, matrix.length])
})

test('nested describe suites retain failure and skip enforcement', () => {
  const nested = (body) =>
    `<testsuites><testsuite file="a.test.ts"><testsuite name="outer"><testsuite name="inner">${body}</testsuite></testsuite></testsuite></testsuites>`
  assert.equal(checkJUnit(nested('<testcase name="contract"/>'), ['a.test.ts']), 1)
  assert.throws(
    () => checkJUnit(nested('<testcase name="contract"><failure/></testcase>'), ['a.test.ts']),
    /Failed test/,
  )
  assert.throws(
    () => checkJUnit(nested('<testcase name="contract"><skipped/></testcase>'), ['a.test.ts']),
    /Unexpected skipped/,
  )
  assert.throws(
    () => checkJUnit(nested('<testcase name="contract" file="different.test.ts"/>'), ['a.test.ts']),
    /file mismatch/,
  )
  assert.throws(
    () =>
      checkJUnit(
        '<testsuites><testsuite file="a.test.ts"/><testsuite file="b.test.ts"><testcase name="contract"/></testsuite></testsuites>',
        ['a.test.ts', 'b.test.ts'],
      ),
    /did not report/,
  )
})
