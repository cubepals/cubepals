// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Requires executed, successful JUnit evidence from both live Fleet suites. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkJUnit } from './coverage-junit.mjs'
import { liveFleet } from './evidence-policy.mjs'

try {
  const paths = process.argv.slice(2)
  const files = [...liveFleet]
  if (paths.length !== files.length || new Set(paths.map((path) => resolve(path))).size !== files.length)
    throw new Error('Expected two distinct reports: one-node.xml two-node.xml')
  const reports = paths.map((reportPath, index) => {
    const document = readFileSync(reportPath)
    const testFile = files[index]
    const executed = checkJUnit(document.toString('utf8'), [testFile], { allowLiveFleetSkips: false })
    return {
      testFile,
      reportPath,
      sha256: createHash('sha256').update(document).digest('hex'),
      executed,
    }
  })
  process.stdout.write(`${JSON.stringify({ passed: true, reports }, null, 2)}\n`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
