// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Behavioral evidence retains nested describe cases without accepting missing or foreign results. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { junitCases } from './behavior-proof.mjs'

const file = 'apps/control/src/app/edge/shared-wake.quality.test.ts'
const report = (body) => `<testsuites><testsuite file="${file}">${body}</testsuite></testsuites>`

test('nested Bun describe suites retain case identity and the intended assertion failure', () => {
  const cases = junitCases(
    report(`<testsuite name="sharing a wake" file="${file}">
      <testcase name="a stranger&apos;s wake" file="${file}" />
      <testsuite name="recovery"><testcase name="a known player" file="${file}">
        <failure message="expect(received).toMatchObject(expected)">actual: asleep</failure>
      </testcase></testsuite>
    </testsuite>`),
    [file],
  )
  assert.equal(cases.length, 2)
  assert.deepEqual(cases[0], { file, name: "a stranger's wake", failure: null })
  assert.equal(cases[1].file, file)
  assert.equal(cases[1].name, 'a known player')
  assert.match(JSON.stringify(cases[1].failure), /expect\(received\)/)
})

test('nested errors and skips cannot count as behavioral defect detection', () => {
  for (const outcome of ['error', 'skipped']) {
    assert.throws(
      () =>
        junitCases(report(`<testsuite><testcase name="case"><${outcome}/></testcase></testsuite>`), [file]),
      /Runner error or skipped test/,
    )
  }
})

test('nested evidence cannot change either suite or case file identity', () => {
  for (const body of [
    '<testsuite file="other.test.ts"><testcase name="case"/></testsuite>',
    '<testsuite><testcase name="case" file="other.test.ts"/></testsuite>',
  ]) {
    assert.throws(() => junitCases(report(body), [file]), /file mismatch/)
  }
})

test('empty, missing, malformed and unnamed evidence fails closed', () => {
  assert.throws(() => junitCases(report('<testsuite/>'), [file]), /No test cases executed/)
  assert.throws(() => junitCases('<testsuites/>', [file]), /Missing behavioral test suites/)
  assert.throws(() => junitCases(report('<testcase>'), [file]), /Malformed behavioral JUnit/)
  assert.throws(() => junitCases(report('<testcase/>'), [file]), /Invalid behavioral test case/)
  assert.throws(
    () => junitCases(report('<testcase name="case"/>'), ['different.test.ts']),
    /Missing behavioral suite/,
  )
})
