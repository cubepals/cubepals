// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
/**
 * Validate every requested test file and distinguish assertion failures from invalid runner output.
 * Under `bail`, files after the first failure may be absent, but only when a test case failed.
 */
import { liveFleet } from './evidence-policy.mjs'
import { XMLParser, XMLValidator } from './toolchain.mjs'

// Exhausted local services and filesystems cannot demonstrate a source-code defect.
const infrastructureFailure =
  /too many clients|remaining connection slots|Cannot use a pool after calling end|No space left on device|\bENOSPC\b|Disk quota exceeded|could not resize shared memory segment|the database system is (?:in recovery mode|starting up|shutting down)|server closed the connection unexpectedly|connection terminated unexpectedly|\bECONNREFUSED\b/i

export function readMutationJUnit(
  xml,
  expected,
  { bail = false, filteredCases = new Set(), caseResults = null, allowedSkippedTests = new Set() } = {},
) {
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
      const id = JSON.stringify([file, test.classname ?? '', test.name])
      if ('error' in test) throw new Error(`Runner error in ${file}`)
      if ('failure' in test && test.failure?.type === 'TimeoutError')
        throw new Error(`Runner timeout in ${file}: ${test.name}`)
      if ('failure' in test && infrastructureFailure.test(JSON.stringify(test.failure)))
        throw new Error(`Infrastructure failure in ${file}: ${test.name}`)
      const status = 'skipped' in test ? 'skipped' : 'failure' in test ? 'failed' : 'passed'
      const result = { id, file, name: test.name, durationMs: Number(test.time) * SECOND_MS, status }
      if (status === 'skipped' && filteredCases.has(id)) {
        caseResults?.push({ ...result, status: 'filtered' })
        continue
      }
      caseResults?.push(result)
      if ('skipped' in test) {
        if (!liveFleet.has(file) && !allowedSkippedTests.has(JSON.stringify([file, test.name])))
          throw new Error(`Unexpected skipped mutation test: ${file}: ${test.name}`)
        outcome.skipped++
        outcome.skippedTests.push(id)
      } else if ('failure' in test) outcome.failed++
      else outcome.passed++
    }
  }
  if (outcome.passed + outcome.failed === 0) throw new Error('No mutation tests executed')
  for (const file of expected)
    if (!seen.has(file) && !(bail && outcome.failed > 0))
      throw new Error(`Mutation test file did not report: ${file}`)
  outcome.skippedTests.sort()
  return outcome
}
