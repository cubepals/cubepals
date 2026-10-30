// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Proves real behavioral tests reject four representative production defects. Only disposable
 * copies are modified; a clean run precedes the experiments and JUnit must identify the intended
 * assertion failure. The evidence includes source hashes and a check that the checkout was untouched.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { XMLParser, XMLValidator } from './toolchain.mjs'

const fixtures = [
  'packages/contracts/src/return-path.ts',
  'packages/contracts/src/return-path.quality.test.ts',
  'packages/contracts/src/durations.ts',
  'packages/contracts/src/proxy-header.ts',
  'packages/contracts/src/edge.ts',
  'packages/contracts/src/edge-poll.ts',
  'apps/edge/limits.ts',
  'apps/edge/limits.quality.test.ts',
  'apps/edge/header.ts',
  'apps/edge/header.quality.test.ts',
  'apps/edge/poll.ts',
  'apps/edge/poll.quality.test.ts',
]

const defects = [
  {
    name: 'redirect-origin-check-removed',
    file: 'packages/contracts/src/return-path.ts',
    before: 'if (url.origin !== BASE) return null',
    after: 'if (false) return null',
    test: 'packages/contracts/src/return-path.quality.test.ts',
    expectedFailure: 'authority syntax stays forbidden after dot-segment normalization',
  },
  {
    name: 'token-boundary-off-by-one',
    file: 'apps/edge/limits.ts',
    before: 'if (this.#tokens < 1) return false',
    after: 'if (this.#tokens <= 1) return false',
    test: 'apps/edge/limits.quality.test.ts',
    expectedFailure: 'a bucket admits exactly its burst and refills only at the next token boundary',
  },
  {
    name: 'fragment-buffer-lost',
    file: 'apps/edge/header.ts',
    before: 'bytes.set(this.#pending)',
    after: '// Deliberate defect: the previous fragment is discarded.',
    test: 'apps/edge/header.quality.test.ts',
    expectedFailure: 'every segmentation preserves the exact payload and the original header',
  },
  {
    name: 'failed-routes-acknowledged',
    file: 'apps/edge/poll.ts',
    before: 'if (!(await this.#take((await response.json()) as EdgeRoutes))) return false',
    after: 'await this.#take((await response.json()) as EdgeRoutes)',
    test: 'apps/edge/poll.quality.test.ts',
    expectedFailure: 'failed updates keep acknowledging only the last fully applied version, then recover',
  },
]

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function junitCases(xml, tests) {
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed behavioral JUnit report')
  const data = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (tag) => ['testsuite', 'testcase'].includes(tag),
  }).parse(xml)
  const suites = data.testsuites?.testsuite
  if (!Array.isArray(suites) || suites.length !== tests.length)
    throw new Error('Missing behavioral test suites')
  const cases = []
  for (const test of tests) {
    const suite = suites.find((entry) => entry.file === test)
    if (!suite?.testcase?.length) throw new Error(`No test cases executed for ${test}`)
    for (const entry of suite.testcase) {
      if ('error' in entry || 'skipped' in entry) throw new Error(`Runner error or skipped test: ${test}`)
      cases.push({ file: test, name: entry.name, failure: entry.failure ?? null })
    }
  }
  return cases
}

function runTests({ snapshot, tests, name, reportDir, bun }) {
  const junit = join(reportDir, `${name}.xml`)
  rmSync(junit, { force: true })
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ)$/.test(key),
    ),
  )
  const result = spawnSync(
    bun,
    ['test', ...tests.map((test) => `./${test}`), '--reporter=junit', `--reporter-outfile=${junit}`],
    { cwd: snapshot, env: environment, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(join(reportDir, `${name}.log`), output)
  if (result.error || result.signal || result.status === null)
    throw new Error(`${name}: Bun did not complete`)
  const cases = junitCases(readFileSync(junit, 'utf8'), tests)
  return {
    exit: result.status,
    passed: cases.filter((entry) => entry.failure === null).length,
    failures: cases.filter((entry) => entry.failure !== null),
  }
}

export function proveBehavior({ root, reportDir, bun = 'bun' }) {
  root = resolve(root)
  reportDir = resolve(reportDir)
  mkdirSync(reportDir, { recursive: true })
  const snapshot = mkdtempSync(join(tmpdir(), 'blockly-behavior-proof-'))
  const originalHashes = Object.fromEntries(fixtures.map((file) => [file, hash(join(root, file))]))
  const evidence = { passed: false, unchanged: false, sources: originalHashes, baseline: null, defects: [] }
  try {
    for (const file of fixtures) {
      const destination = join(snapshot, file)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(root, file), destination)
    }
    // Only external libraries are linked. Workspace imports cannot silently reach unmutated source.
    mkdirSync(join(snapshot, 'node_modules'))
    for (const dependency of ['fast-check', 'zod']) {
      symlinkSync(
        realpathSync(join(root, 'node_modules', dependency)),
        join(snapshot, 'node_modules', dependency),
        'dir',
      )
    }
    const tests = fixtures.filter((file) => file.endsWith('.quality.test.ts'))
    const baseline = runTests({ snapshot, tests, name: 'clean', reportDir, bun })
    evidence.baseline = { exit: baseline.exit, passed: baseline.passed, failures: baseline.failures }
    if (baseline.exit !== 0 || baseline.failures.length > 0 || baseline.passed < 12) {
      throw new Error('Clean behavioral tests did not pass; defect experiments are invalid')
    }
    for (const defect of defects) {
      const path = join(snapshot, defect.file)
      const original = readFileSync(path, 'utf8')
      if (original.split(defect.before).length !== 2) throw new Error(`Defect anchor changed: ${defect.name}`)
      writeFileSync(path, original.replace(defect.before, defect.after))
      const run = runTests({ snapshot, tests: [defect.test], name: defect.name, reportDir, bun })
      writeFileSync(path, original)
      const expected = run.failures.find((failure) => failure.name === defect.expectedFailure)
      const rejected =
        run.exit !== 0 &&
        expected !== undefined &&
        /expect\(received\)/.test(JSON.stringify(expected.failure))
      evidence.defects.push({
        name: defect.name,
        file: defect.file,
        exit: run.exit,
        rejected,
        expectedFailure: defect.expectedFailure,
        failures: run.failures,
      })
      if (!rejected) throw new Error(`Defect was not rejected by its intended assertion: ${defect.name}`)
      console.warn(`${defect.name}: rejected by its intended test (exit ${run.exit})`)
    }
    evidence.passed = true
  } catch (error) {
    evidence.error = error.message
    throw error
  } finally {
    rmSync(snapshot, { recursive: true, force: true })
    evidence.unchanged = fixtures.every((file) => hash(join(root, file)) === originalHashes[file])
    evidence.passed &&= evidence.unchanged
    writeFileSync(join(reportDir, 'behavior-proof.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  }
  if (!evidence.unchanged) throw new Error('Behavioral proof inputs changed in the original checkout')
  return evidence
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
  const reportDir = resolve(process.argv[3] ?? join(root, 'coverage', 'behavior-proof'))
  try {
    proveBehavior({ root, reportDir })
    console.warn(`Behavioral defect evidence: ${join(reportDir, 'behavior-proof.json')}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
