// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stryker's command runner sees only an exit code. Preserve Bun's JUnit evidence separately so
 * a missing executable, empty test run, skipped suite or runner error cannot masquerade as a
 * killed mutant. The controller validates this evidence after Stryker restores the source.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMutationJUnit } from './mutation-evidence.mjs'

const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const mutant = process.env.__STRYKER_ACTIVE_MUTANT__ ?? 'baseline'
if (!/^(?:baseline|\d+)$/.test(mutant)) throw new Error('Invalid Stryker mutant identifier')
mkdirSync(manifest.evidence, { recursive: true })
const junit = join(manifest.evidence, `${mutant}.xml`)
const outcome = { status: 'runner-error', passed: 0, failed: 0, skipped: 0 }
const started = Date.now()
try {
  if (!Array.isArray(manifest.tests) || manifest.tests.length === 0) throw new Error('No tests selected')
  const baseline =
    mutant === 'baseline' ? null : JSON.parse(readFileSync(join(manifest.evidence, 'baseline.json'), 'utf8'))
  // Finish before Stryker's outer timeout so even a synchronous infinite loop leaves evidence.
  const timeout = baseline
    ? Math.min(manifest.timeoutMs, Math.ceil(baseline.durationMs * 1.5) + 3000)
    : manifest.timeoutMs
  const run = spawnSync(
    manifest.bun,
    ['test', ...manifest.tests.map((file) => `./${file}`), '--reporter=junit', `--reporter-outfile=${junit}`],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout,
    },
  )
  process.stdout.write(run.stdout ?? '')
  process.stderr.write(run.stderr ?? '')
  if (run.error?.code === 'ETIMEDOUT') outcome.status = 'timeout'
  if (run.error || run.signal || run.status === null) throw new Error('Bun process did not finish normally')
  const xml = readFileSync(junit, 'utf8')
  Object.assign(outcome, readMutationJUnit(xml, manifest.tests))
  if (run.status === 0 && outcome.failed === 0) outcome.status = 'passed'
  else if (run.status !== 0 && outcome.failed > 0) outcome.status = 'test-failure'
  else throw new Error('Bun exit status disagrees with its test results')
} catch (error) {
  outcome.reason = String(error)
  process.stderr.write(`${error}\n`)
} finally {
  outcome.durationMs = Date.now() - started
  writeFileSync(join(manifest.evidence, `${mutant}.json`), JSON.stringify(outcome))
}
process.exitCode = outcome.status === 'passed' ? 0 : 1
