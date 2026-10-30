// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Evidence cannot vanish behind a green aggregate, an empty test run, or a skipped scenario. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyJobs } from './aggregate.mjs'
import { checkJUnit } from './run-shard.mjs'
import { groupOf, groups } from './shards.mjs'

const clean = () =>
  Object.fromEntries(
    ['changes', 'licenses', 'static', 'test', 'quality', 'worker', 'images', 'reporter'].map((key) => [
      key,
      { result: 'success', ...(key === 'changes' ? { outputs: { code: 'true', reporter: 'true' } } : {}) },
    ]),
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
  needs.changes.outputs = { code: 'false', reporter: 'false' }
  for (const job of ['static', 'test', 'quality', 'worker', 'images', 'reporter'])
    needs[job].result = 'skipped'
  assert.equal(verifyJobs(needs), true)
  needs.licenses.result = 'skipped'
  assert.throws(() => verifyJobs(needs), /must succeed/)
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
