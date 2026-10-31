// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Checks complete JUnit evidence, including nested suites, failures and unexpected skips. */
import { liveFleet } from './evidence-policy.mjs'
import { XMLParser, XMLValidator } from './toolchain.mjs'

export function checkJUnit(xml, expected) {
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed JUnit evidence')
  const data = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (tag) => ['testsuite', 'testcase'].includes(tag),
  }).parse(xml)
  const suites = data.testsuites?.testsuite
  if (!Array.isArray(suites) || !suites.length) throw new Error('Missing JUnit test suites')
  const seen = new Set()
  let executed = 0
  function visit(suite, parentFile) {
    const file = (suite.file ?? parentFile)?.replace(/^\.\//, '')
    if (!expected.includes(file)) throw new Error(`Unexpected JUnit test file: ${file}`)
    for (const test of suite.testcase ?? []) {
      if (!test || typeof test !== 'object' || typeof test.name !== 'string' || !test.name)
        throw new Error(`Invalid JUnit test case: ${file}`)
      if (test.file && test.file.replace(/^\.\//, '') !== file)
        throw new Error(`JUnit case file mismatch: ${file}`)
      seen.add(file)
      if ('failure' in test || 'error' in test) throw new Error(`Failed test: ${file}: ${test.name}`)
      if ('skipped' in test) {
        if (!liveFleet.has(file)) throw new Error(`Unexpected skipped test: ${file}: ${test.name}`)
      } else executed++
    }
    for (const child of suite.testsuite ?? []) visit(child, file)
  }
  for (const suite of suites) visit(suite)
  if (executed === 0) throw new Error('No tests executed')
  for (const file of expected) if (!seen.has(file)) throw new Error(`Test file did not report: ${file}`)
  return executed
}

