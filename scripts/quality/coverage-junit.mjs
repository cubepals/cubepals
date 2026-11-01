// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Checks complete JUnit evidence and combines isolated phases without flattening suites. */
import { liveFleet } from './evidence-policy.mjs'
import { requireQuality, XMLParser, XMLValidator } from './toolchain.mjs'

export function checkJUnit(
  xml,
  expected,
  { allowOptionalOnly = false, allowLiveFleetSkips = true, allowedSkippedTests = new Set() } = {},
) {
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed JUnit evidence')
  const data = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (tag) => ['testsuite', 'testcase'].includes(tag),
  }).parse(xml)
  const suites = data.testsuites?.testsuite
  if (!Array.isArray(suites) || !suites.length) throw new Error('Missing JUnit test suites')
  function checkStatuses(node) {
    if (allowLiveFleetSkips) return
    for (const status of ['failure', 'error']) {
      if (status in node) throw new Error(`Failed strict JUnit ${status}`)
    }
    for (const status of ['failures', 'errors', 'skipped']) {
      if (node[status] !== undefined && !/^0$/.test(String(node[status])))
        throw new Error(`Invalid strict JUnit ${status}: ${node[status]}`)
    }
  }
  checkStatuses(data.testsuites)
  const seen = new Set()
  let executed = 0
  function visit(suite, parentFile) {
    checkStatuses(suite)
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
        if (
          (!allowLiveFleetSkips || !liveFleet.has(file)) &&
          !allowedSkippedTests.has(JSON.stringify([file, test.name]))
        )
          throw new Error(`Unexpected skipped test: ${file}: ${test.name}`)
      } else executed++
    }
    for (const child of suite.testsuite ?? []) visit(child, file)
  }
  for (const suite of suites) visit(suite)
  if (executed === 0 && !(allowOptionalOnly && expected.every((file) => liveFleet.has(file))))
    throw new Error('No tests executed')
  for (const file of expected) if (!seen.has(file)) throw new Error(`Test file did not report: ${file}`)
  return executed
}

export function mergeJUnit(documents) {
  if (documents.length === 1) return documents[0]
  const parser = new XMLParser({
    ignoreAttributes: false,
    isArray: (tag) => ['testsuite', 'testcase'].includes(tag),
  })
  const roots = documents.map((xml) => parser.parse(xml).testsuites)
  const merged = { testsuite: roots.flatMap((root) => root.testsuite) }
  for (const key of ['tests', 'failures', 'errors', 'skipped', 'time']) {
    merged[`@_${key}`] = roots.reduce((total, root) => total + Number(root[`@_${key}`] ?? 0), 0)
  }
  const { XMLBuilder } = requireQuality('fast-xml-parser')
  return new XMLBuilder({ ignoreAttributes: false }).build({ testsuites: merged })
}
