// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prepares branch instrumentation once, then starts a fresh Bun process for every test file.
 * Existing unmodified tests finish before new or changed tests start. The parent validates and
 * retains each file's evidence before the next process can affect filesystem or service state.
 * Process boundaries also isolate native addons, whose lifetime outlasts Bun's module realms.
 * JUnit, exact sparse fragments and unchanged tracked inputs are required for a complete shard.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MINUTE_MS } from '../../packages/contracts/src/durations.ts'
import { mergeReports, validateReport } from './coverage.mjs'
import { writeRuntimeManifest } from './coverage-cache.mjs'
import { createFragmentCollector } from './coverage-fragments.mjs'
import { assertInputsUnchanged, partitionTests, snapshotInputs, testManifest } from './coverage-inputs.mjs'
import { checkJUnit, mergeJUnit } from './coverage-junit.mjs'
import { groupOf, groups } from './shards.mjs'

export { checkJUnit } from './coverage-junit.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function runShard({ root, group, reportDir, baseManifest }) {
  root = resolve(root)
  reportDir = resolve(reportDir)
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
    maxBuffer: 32 * 1024 * 1024,
  })
  if (listed.status !== 0) throw new Error('Cannot enumerate test files')
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))]
  const tests = paths
    .filter(
      (file) =>
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
        !file.startsWith('scripts/quality/') &&
        groupOf(file) === group &&
        existsSync(resolve(root, file)),
    )
    .sort()
  if (!tests.length) throw new Error(`No tests in ${group}`)
  const base = baseManifest ? JSON.parse(readFileSync(baseManifest, 'utf8')) : undefined
  const inputs = snapshotInputs(
    root,
    paths.filter((file) => /\.[cm]?[jt]sx?$/.test(file)),
  )
  mkdirSync(reportDir, { recursive: true })
  const junit = resolve(reportDir, `${group}.xml`)
  const report = resolve(reportDir, `${group}.json`)
  mkdirSync(resolve(reportDir, 'manifests'), { recursive: true })
  const manifest = resolve(reportDir, 'manifests', `${group}.json`)
  for (const path of [junit, report, manifest]) rmSync(path, { force: true })
  const temporary = mkdtempSync(join(tmpdir(), `quality-${group}-`))
  const deadline = Date.now() + 30 * MINUTE_MS
  try {
    const preparedPath = join(temporary, 'prepared.json')
    const selection = join(temporary, 'tests.json')
    writeFileSync(selection, JSON.stringify(tests))
    const preparation = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./coverage-prepare.mjs', import.meta.url)), root, preparedPath, selection],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    if (preparation.error) throw preparation.error
    if (preparation.status !== 0) throw new Error(`Coverage preparation failed: ${preparation.stderr}`)
    const preparedBytes = readFileSync(preparedPath)
    const prepared = JSON.parse(preparedBytes)
    const runtime = writeRuntimeManifest(prepared, temporary)
    const preparedSha256 = runtime.sha256
    assertInputsUnchanged(root, inputs)
    const phases = partitionTests(prepared.tests, base)
    const reports = []
    const documents = []
    let executed = 0
    for (const phase of phases) {
      const phaseName = `${group}:${phase.name}`
      const collector = createFragmentCollector(prepared, phase.tests, { preparedSha256, phase: phaseName })
      for (const testPath of phase.tests) {
        const identity = `${phase.name}-${sha256(testPath)}`
        const parts = join(temporary, identity)
        const fileJUnit = join(temporary, `${identity}.xml`)
        mkdirSync(parts)
        const result = spawnSync(
          process.env.QUALITY_BUN ?? 'bun',
          [
            'test',
            '--preload',
            fileURLToPath(new URL('./coverage-preload.mjs', import.meta.url)),
            '--reporter=junit',
            `--reporter-outfile=${fileJUnit}`,
            `./${testPath}`,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              QUALITY_ROOT: root,
              QUALITY_REPORT: report,
              QUALITY_SHARD: group,
              QUALITY_PREPARED: runtime.path,
              QUALITY_PREPARED_SHA256: preparedSha256,
              QUALITY_PARTS: parts,
              QUALITY_PHASE: phaseName,
            },
            stdio: 'inherit',
            timeout: Math.max(1, deadline - Date.now()),
          },
        )
        assertInputsUnchanged(root, inputs)
        if (sha256(readFileSync(runtime.path)) !== preparedSha256)
          throw new Error('Test run modified the prepared coverage manifest')
        if (result.status !== 0)
          throw new Error(`Test file ${testPath} failed (${result.status ?? result.error ?? result.signal})`)
        const xml = readFileSync(fileJUnit, 'utf8')
        executed += checkJUnit(xml, [testPath], { allowOptionalOnly: true })
        const fragments = readdirSync(parts)
          .sort()
          .map((name) => {
            const path = join(parts, name)
            if (!/^[a-f0-9]{64}\.json$/.test(name) || !lstatSync(path).isFile())
              throw new Error(`Unexpected coverage fragment entry: ${name}`)
            const fragment = JSON.parse(readFileSync(path, 'utf8'))
            if (!fragment.test || name !== `${sha256(fragment.test.path)}.json`)
              throw new Error(`Coverage fragment filename does not match its test: ${name}`)
            return fragment
          })
        // Absorb evidence in trusted parent memory before subsequent tests can touch its files.
        collector.accept(fragments, [testPath])
        documents.push(xml)
        rmSync(parts, { recursive: true, force: true })
        rmSync(fileJUnit, { force: true })
      }
      reports.push(collector.finish())
      console.warn(`${phaseName}: ${phase.tests.length} isolated test files verified`)
    }
    const combined = mergeReports(reports, reports.length)
    combined.shards = [group]
    validateReport(combined)
    const xml = mergeJUnit(documents)
    if (checkJUnit(xml, tests) !== executed) throw new Error('Merged JUnit execution count differs')
    assertInputsUnchanged(root, inputs)
    writeFileSync(report, `${JSON.stringify(combined)}\n`)
    writeFileSync(junit, xml)
    writeFileSync(manifest, `${JSON.stringify(testManifest(prepared.tests), null, 2)}\n`)
    console.warn(`${group}: ${executed} executed cases and complete coverage evidence verified`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, group, reportDir, baseManifest] = process.argv.slice(2)
    if (!root || !group || !reportDir)
      throw new Error('Usage: run-shard.mjs ROOT GROUP REPORT_DIR [BASE_TEST_MANIFEST]')
    runShard({ root, group, reportDir, baseManifest })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
