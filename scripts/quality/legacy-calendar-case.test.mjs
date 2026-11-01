// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The existing calendar guard cannot permit a new, renamed, changed, or out-of-window skip. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkJUnit } from './coverage-junit.mjs'
import { legacyCalendarCase, legacyCalendarSkips } from './legacy-calendar-case.mjs'
import { readMutationJUnit } from './mutation-evidence.mjs'

const during = new Date('2040-02-01T01:00:00Z')
const after = new Date('2040-02-01T04:00:00Z')
const xml = (name = legacyCalendarCase.name, onlySkipped = false) =>
  `<testsuites><testsuite file="${legacyCalendarCase.path}">${onlySkipped ? '' : '<testcase name="another required test"/>'}<testcase name="${name}"><skipped/></testcase></testsuite></testsuites>`

test('the immutable existing guard is recognised only during its original four-hour window', () => {
  const allowed = legacyCalendarSkips(legacyCalendarCase, during, during)
  assert.equal(allowed.size, 1)
  assert.equal(checkJUnit(xml(), [legacyCalendarCase.path], { allowedSkippedTests: allowed }), 1)
  const result = readMutationJUnit(xml(), [legacyCalendarCase.path], { allowedSkippedTests: allowed })
  assert.equal(result.passed, 1)
  assert.equal(result.skipped, 1)
  assert.throws(() => checkJUnit(xml(), [legacyCalendarCase.path]), /Unexpected skipped/)
  assert.throws(() => readMutationJUnit(xml(), [legacyCalendarCase.path]), /Unexpected skipped/)
})

test('a fixed or edited fixture, different path, and out-of-window skip remain failures', () => {
  for (const item of [
    { ...legacyCalendarCase, sha256: '0'.repeat(64) },
    { ...legacyCalendarCase, path: 'apps/other.test.ts' },
  ])
    assert.equal(legacyCalendarSkips(item, during, during).size, 0)
  const outside = legacyCalendarSkips(legacyCalendarCase, after, after)
  assert.equal(outside.size, 0)
  assert.throws(
    () => checkJUnit(xml(), [legacyCalendarCase.path], { allowedSkippedTests: outside }),
    /Unexpected skipped/,
  )
  const allowed = legacyCalendarSkips(legacyCalendarCase, during, during)
  assert.throws(
    () =>
      checkJUnit(xml('a different skipped case'), [legacyCalendarCase.path], {
        allowedSkippedTests: allowed,
      }),
    /Unexpected skipped/,
  )
  assert.throws(
    () => checkJUnit(xml(undefined, true), [legacyCalendarCase.path], { allowedSkippedTests: allowed }),
    /No tests executed/,
  )
})

test('a run straddling a calendar boundary uses its trusted parent start and finish times', () => {
  assert.equal(legacyCalendarSkips(legacyCalendarCase, new Date('2040-01-31T23:59:59Z'), during).size, 1)
  assert.equal(legacyCalendarSkips(legacyCalendarCase, during, after).size, 1)
  assert.equal(legacyCalendarSkips(legacyCalendarCase, after, new Date('2040-02-02T01:00:00Z')).size, 0)
})
