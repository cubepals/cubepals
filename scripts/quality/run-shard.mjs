// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs exactly one existing test shard with branch instrumentation. JUnit is required evidence;
 * missing tests, failures, and skipped cases outside the separately run live fleet suite fail.
 * The trusted checkout supplies this runner and its preload even when testing the base tree.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveFleet } from './evidence-policy.mjs'
import { groupOf, groups } from './shards.mjs'
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

export function runShard({ root, group, reportDir }) {
  if (!Object.hasOwn(groups, group)) throw new Error(`Unknown test group ${group}`)
  for (const key of [
    'DATABASE_URL',
    'NATS_TEST_URL',
    'S3_TEST_ENDPOINT',
    'S3_TEST_BUCKET',
    'PEBBLE_TEST_URL',
    'CHALLTESTSRV_TEST_URL',
  ]) {
    if (!process.env[key]) throw new Error(`Required CI service variable is absent: ${key}`)
  }
  if (group === 'web' && !process.env.MC_ROUTER_BIN)
    throw new Error('MC_ROUTER_BIN is required for edge integration tests')
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (listed.status !== 0) throw new Error('Cannot enumerate test files')
  const tests = [...new Set(listed.stdout.split('\0'))]
    .filter(
      (file) =>
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
        !file.startsWith('scripts/quality/') &&
        groupOf(file) === group &&
        existsSync(resolve(root, file)),
    )
    .sort()
  if (!tests.length) throw new Error(`No tests in ${group}`)
  mkdirSync(reportDir, { recursive: true })
  const junit = resolve(reportDir, `${group}.xml`)
  const report = resolve(reportDir, `${group}.json`)
  rmSync(junit, { force: true })
  rmSync(report, { force: true })
  const result = spawnSync(
    process.env.QUALITY_BUN ?? 'bun',
    [
      'test',
      '--preload',
      fileURLToPath(new URL('./coverage-preload.mjs', import.meta.url)),
      '--reporter=junit',
      `--reporter-outfile=${junit}`,
      ...tests.map((file) => `./${file}`),
    ],
    {
      cwd: root,
      env: { ...process.env, QUALITY_ROOT: root, QUALITY_REPORT: report, QUALITY_SHARD: group },
      stdio: 'inherit',
      timeout: 1_800_000,
    },
  )
  if (result.status !== 0)
    throw new Error(`Test shard ${group} failed (${result.status ?? result.error ?? result.signal})`)
  const count = checkJUnit(readFileSync(junit, 'utf8'), tests)
  if (!existsSync(report)) throw new Error(`Missing coverage for ${group}`)
  console.warn(`${group}: ${count} executed cases and coverage evidence verified`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, group, reportDir] = process.argv.slice(2)
    if (!root || !group || !reportDir) throw new Error('Usage: run-shard.mjs ROOT GROUP REPORT_DIR')
    runShard({ root: resolve(root), group, reportDir: resolve(reportDir) })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
