// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Validate every requested test file and distinguish assertion failures from invalid runner output. */
import { liveFleet } from './evidence-policy.mjs'
import { XMLParser, XMLValidator } from './toolchain.mjs'

export function readMutationJUnit(xml, expected) {
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed mutation JUnit evidence')
  const data = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (tag) => ['testsuite', 'testcase'].includes(tag),
  }).parse(xml)
  const suites = data.testsuites?.testsuite
  if (!Array.isArray(suites) || suites.length === 0) throw new Error('Missing mutation JUnit suites')
  const seen = new Set()
  const outcome = { passed: 0, failed: 0, skipped: 0, skippedTests: [] }
  const pending = suites.map((suite) => ({ suite, parentFile: undefined }))
  while (pending.length) {
    const { suite, parentFile } = pending.pop()
    const file = (suite.file ?? parentFile)?.replace(/^\.\//, '')
    if (!expected.includes(file)) throw new Error(`Unexpected mutation test file: ${file}`)
    const cases = suite.testcase ?? []
    const children = suite.testsuite ?? []
    if (!Array.isArray(cases) || !Array.isArray(children) || cases.length + children.length === 0)
      throw new Error(`No test cases in ${file}`)
    if (cases.length) seen.add(file)
    pending.push(...children.map((child) => ({ suite: child, parentFile: file })))
    for (const test of cases) {
      if (!test || typeof test !== 'object' || typeof test.name !== 'string' || !test.name)
        throw new Error(`Invalid test case in ${file}`)
      if ('error' in test) throw new Error(`Runner error in ${file}`)
      if ('skipped' in test) {
        if (!liveFleet.has(file)) throw new Error(`Unexpected skipped mutation test: ${file}: ${test.name}`)
        outcome.skipped++
        outcome.skippedTests.push(JSON.stringify([file, test.classname ?? '', test.name]))
      } else if ('failure' in test) outcome.failed++
      else outcome.passed++
    }
  }
  for (const file of expected)
    if (!seen.has(file)) throw new Error(`Mutation test file did not report: ${file}`)
  if (outcome.passed + outcome.failed === 0) throw new Error('No mutation tests executed')
  outcome.skippedTests.sort()
  return outcome
}
