// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stryker's command runner sees only an exit code. Preserve Bun's JUnit evidence separately so
 * a missing executable, empty test run, skipped suite or runner error cannot masquerade as a
 * killed mutant. The controller validates this evidence after Stryker restores the source.
 * Mutant runs stop at the first failing test: a kill needs one failure, and survivors still run
 * every test. Past the subject's deadline a mutant is recorded as not evaluated, never as killed,
 * so Stryker finishes with a complete report instead of being stopped mid-run.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { mergeJUnit } from './coverage-junit.mjs'
import { legacyCalendarSkips } from './legacy-calendar-case.mjs'
import { proveCaseOrder, runCaseOrder } from './mutation-case-order.mjs'
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
  if (baseline && Number.isFinite(manifest.deadline) && Date.now() >= manifest.deadline) {
    outcome.status = 'budget-exhausted'
    throw new Error('The subject reached its mutation time budget before this mutant ran')
  }
  // Finish before Stryker's outer timeout so even a synchronous infinite loop leaves evidence.
  const timeout = baseline
    ? Math.min(
        manifest.timeoutMs,
        Math.ceil((baseline.caseOrder?.durationMs ?? baseline.durationMs) * 1.5) + 3 * SECOND_MS,
      )
    : manifest.timeoutMs
  const execute = (tests, report, { pattern, bail = false, until = started + timeout } = {}) => {
    const began = Date.now()
    const documents = []
    const allowedSkippedTests = new Set()
    let exitCode = 0
    if (tests.length > 1) mkdirSync(`${report}.files`, { recursive: true })
    for (const [index, file] of tests.entries()) {
      const remaining = Math.min(until, manifest.deadline ?? Infinity) - Date.now()
      if (remaining <= 0) {
        outcome.status = 'budget-exhausted'
        throw new Error('Mutation execution reached its deadline')
      }
      const into = tests.length === 1 ? report : join(`${report}.files`, `${index}.xml`)
      const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
      const beganFile = new Date()
      const run = spawnSync(
        manifest.bun,
        [
          'test',
          `./${file}`,
          ...(pattern ? ['--test-name-pattern', pattern] : []),
          ...(bail ? ['--bail'] : []),
          '--reporter=junit',
          `--reporter-outfile=${into}`,
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          timeout: Math.max(1, Math.ceil(remaining)),
        },
      )
      process.stdout.write(run.stdout ?? '')
      process.stderr.write(run.stderr ?? '')
      if (run.error?.code === 'ETIMEDOUT') outcome.status = 'timeout'
      if (run.error || run.signal || run.status === null)
        throw new Error('Bun process did not finish normally')
      documents.push(readFileSync(into, 'utf8'))
      for (const identity of legacyCalendarSkips({ path: file, sha256 }, beganFile, new Date()))
        allowedSkippedTests.add(identity)
      if (run.status !== 0) {
        exitCode = run.status
        if (bail) break
      }
    }
    const xml = mergeJUnit(documents)
    if (tests.length > 1) writeFileSync(report, xml)
    return {
      xml,
      exitCode,
      durationMs: Date.now() - began,
      report,
      allowedSkippedTests,
    }
  }
  if (baseline?.caseOrder) {
    const directory = join(manifest.evidence, `${mutant}-cases`)
    mkdirSync(directory, { recursive: true })
    Object.assign(
      outcome,
      runCaseOrder(baseline.caseOrder, manifest.tests, (batch, index) =>
        execute([batch.file], join(directory, `${index}.xml`), { pattern: batch.pattern, bail: true }),
      ),
    )
    outcome.status = outcome.failed > 0 ? 'test-failure' : 'passed'
  } else {
    const cases = []
    const run = execute(manifest.tests, junit, { bail: Boolean(baseline) })
    Object.assign(
      outcome,
      readMutationJUnit(run.xml, manifest.tests, {
        bail: Boolean(baseline),
        caseResults: cases,
        allowedSkippedTests: run.allowedSkippedTests,
      }),
    )
    if (run.exitCode === 0 && outcome.failed === 0) outcome.status = 'passed'
    else if (run.exitCode !== 0 && outcome.failed > 0) outcome.status = 'test-failure'
    else throw new Error('Bun exit status disagrees with its test results')
    if (!baseline && outcome.status === 'passed' && manifest.allowCaseBatches !== false) {
      const directory = join(manifest.evidence, 'baseline-cases')
      mkdirSync(directory, { recursive: true })
      const until = Math.min(
        started + manifest.timeoutMs - 3 * SECOND_MS,
        Date.now() + Math.min(2 * run.durationMs, 120 * SECOND_MS),
      )
      const plan = proveCaseOrder(cases, manifest.tests, run.durationMs, (batch, index) =>
        execute([batch.file], join(directory, `${index}.xml`), { pattern: batch.pattern, until }),
      )
      // An unsupported split keeps the successful original baseline and the original command.
      outcome.status = 'passed'
      if (plan) outcome.caseOrder = plan
    }
  }
} catch (error) {
  outcome.reason = String(error)
  process.stderr.write(`${error}\n`)
} finally {
  outcome.durationMs = Date.now() - started
  writeFileSync(join(manifest.evidence, `${mutant}.json`), JSON.stringify(outcome))
}
process.exitCode = outcome.status === 'passed' ? 0 : 1
