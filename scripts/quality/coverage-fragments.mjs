// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Joins one isolated test file's sparse counters to the trusted, complete zero-hit inventory.
 * The parent consumes each file's evidence before another test process starts. Missing, duplicated,
 * foreign or stale file fragments cannot silently erase files or increase their percentages.
 */
import { coverageIdentity, validateFileCoverage, validateReport } from './coverage.mjs'

export function createFragmentCollector(prepared, expectedTests, { preparedSha256, phase }) {
  if (
    prepared?.version !== 2 ||
    typeof prepared.runId !== 'string' ||
    !prepared.runId ||
    typeof prepared.root !== 'string' ||
    !Array.isArray(prepared.tests)
  )
    throw new Error('Invalid prepared coverage manifest')
  if (!/^[a-f0-9]{64}$/.test(preparedSha256) || typeof phase !== 'string' || !phase)
    throw new Error('Missing prepared digest or phase')
  if (
    !Array.isArray(expectedTests) ||
    expectedTests.length === 0 ||
    new Set(expectedTests).size !== expectedTests.length
  )
    throw new Error('Expected isolated test files must be nonempty and unique')
  const tests = new Map(prepared.tests.map((entry) => [entry.path, entry.sha256]))
  if (tests.size !== prepared.tests.length) throw new Error('Duplicate prepared test identity')
  const wanted = new Set(expectedTests)
  for (const path of wanted) if (!tests.has(path)) throw new Error(`Unexpected prepared test: ${path}`)
  const report = validateReport({
    version: 1,
    inventory: prepared.inventory,
    shards: [phase],
    files: structuredClone(prepared.templates),
  })
  const seen = new Set()
  let finished = false
  const accept = (fragments, expectedBatch) => {
    if (finished) throw new Error('Coverage fragment collector already finished')
    if (
      !Array.isArray(fragments) ||
      !Array.isArray(expectedBatch) ||
      expectedBatch.length === 0 ||
      new Set(expectedBatch).size !== expectedBatch.length ||
      expectedBatch.some((path) => !wanted.has(path))
    )
      throw new Error('Expected fragment batch must identify unique selected tests')
    const batch = new Set(expectedBatch)
    for (const path of batch) if (seen.has(path)) throw new Error(`Duplicate fragment test: ${path}`)
    for (const fragment of fragments) {
      if (
        fragment?.version !== 1 ||
        fragment.runId !== prepared.runId ||
        fragment.preparedSha256 !== preparedSha256 ||
        fragment.phase !== phase
      )
        throw new Error('Stale or foreign coverage fragment')
      const test = fragment.test
      if (!test || !batch.has(test.path)) throw new Error(`Unexpected fragment test: ${test?.path}`)
      if (seen.has(test.path)) throw new Error(`Duplicate fragment test: ${test.path}`)
      if (test.sha256 !== tests.get(test.path)) throw new Error(`Stale fragment test hash: ${test.path}`)
      seen.add(test.path)
      if (!fragment.files || typeof fragment.files !== 'object' || Array.isArray(fragment.files))
        throw new Error(`Missing fragment counters: ${test.path}`)
      for (const [path, file] of Object.entries(fragment.files)) {
        const into = report.files[path]
        if (!into) throw new Error(`Unexpected fragment source: ${path}`)
        validateFileCoverage(path, file)
        if (coverageIdentity(into) !== coverageIdentity(file))
          throw new Error(`Fragment source maps differ: ${path}`)
        for (const metric of ['s', 'f'])
          for (const [key, value] of Object.entries(file[metric])) into[metric][key] += value
        for (const [key, values] of Object.entries(file.b))
          values.forEach((value, arm) => {
            into.b[key][arm] += value
          })
      }
    }
    for (const path of batch) if (!seen.has(path)) throw new Error(`Missing coverage fragment: ${path}`)
  }
  const finish = () => {
    for (const path of wanted) if (!seen.has(path)) throw new Error(`Missing coverage fragment: ${path}`)
    finished = true
    return validateReport(report)
  }
  return { accept, finish }
}

export function mergeFragments(prepared, fragments, expectedTests, options) {
  const collector = createFragmentCollector(prepared, expectedTests, options)
  collector.accept(fragments, expectedTests)
  return collector.finish()
}
