// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real isolated Bun tests prove that narrowed evidence stays complete and genuine defects fail. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { checkCoverage, mergeReports } from './coverage.mjs'
import { coverageLineRanges } from './coverage-lines.mjs'
import { mergeNativePartitions } from './coverage-partitions.mjs'
import { testPlan } from './partition-plan.mjs'
import { runShard } from './run-shard.mjs'
import { groups } from './shards.mjs'

test('scoped native coverage preserves debt, binds every oracle, and rejects an actual wrong return', () => {
  const started = performance.now()
  const dir = mkdtempSync(join(tmpdir(), 'scoped-native-proof-'))
  const root = join(dir, 'head'),
    baseRoot = join(dir, 'base'),
    reports = join(dir, 'reports')
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'Fixture',
    )
    return git('rev-parse', 'HEAD')
  }
  const module = 'apps/web/value.ts',
    oracle = 'apps/web/value.test.ts'
  const original =
    'export function value(flag: boolean) { if (flag) return 1; return 0 }\nexport function legacy(flag: boolean) { return flag ? 10 : 20 }\n'
  put(module, original)
  put(
    oracle,
    'import {test,expect} from "bun:test";import {value} from "./value";test("both outcomes",()=>{expect(value(true)).toBe(1);expect(value(false)).toBe(0)})\n',
  )
  put('scripts/quality/runtime-costs.json', '{"tests":{},"mutations":{}}')
  try {
    git('init', '-q', '--template=', '-b', 'main')
    const base = commit()
    put(module, original.replace('if (flag) return 1; return 0', 'return flag ? 1 : 0'))
    const head = commit()
    git('worktree', 'add', '--detach', baseRoot, base)
    const plan = testPlan(root, base, head, 'affected')
    assert.equal(plan.impact.services, false)
    runShard({ root: baseRoot, group: 'web', reportDir: join(reports, 'base'), plan, partition: 0 })
    runShard({
      root,
      group: 'web',
      reportDir: join(reports, 'head'),
      plan,
      partition: 0,
      baseManifest: join(reports, 'base/manifests/web-0.json'),
    })
    const previous = process.env.QUALITY_EXECUTION_SCOPE
    process.env.QUALITY_EXECUTION_SCOPE = 'affected'
    try {
      mergeNativePartitions({ root, baseRoot, directory: reports, base })
    } finally {
      if (previous === undefined) delete process.env.QUALITY_EXECUTION_SCOPE
      else process.env.QUALITY_EXECUTION_SCOPE = previous
    }
    const read = (side) =>
      mergeReports(
        Object.keys(groups).map((group) =>
          JSON.parse(readFileSync(join(reports, 'merged', side, `${group}.json`))),
        ),
        7,
      )
    const before = read('base'),
      after = read('head')
    const ranges = coverageLineRanges(root, { base, head }, [module], after.files)
    const result = checkCoverage(after, before, [module], undefined, new Set([module]), ranges)
    assert.deepEqual(result.failures, [])
    assert.ok(result.legacyDeficits.some((debt) => debt.path === module && debt.metric === 'functions'))
    rmSync(join(reports, 'head/web-0.json'))
    process.env.QUALITY_EXECUTION_SCOPE = 'affected'
    try {
      assert.throws(
        () => mergeNativePartitions({ root, baseRoot, directory: reports, base }),
        /No executed native evidence|ENOENT/,
      )
    } finally {
      if (previous === undefined) delete process.env.QUALITY_EXECUTION_SCOPE
      else process.env.QUALITY_EXECUTION_SCOPE = previous
    }
    put(module, original.replace('return 1', 'return 2'))
    const broken = commit()
    const brokenPlan = testPlan(root, base, broken, 'affected')
    let defectOutput = ''
    try {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {runShard} from ${JSON.stringify(new URL('./run-shard.mjs', import.meta.url).href)};runShard(${JSON.stringify({ root, group: 'web', reportDir: join(dir, 'broken'), plan: brokenPlan, partition: 0 })})`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      assert.fail('The actual wrong return must fail its existing oracle')
    } catch (error) {
      assert.equal(error.status, 1)
      defectOutput = `${error.stdout}\n${error.stderr}`
      assert.match(defectOutput, /Expected: 1/)
      assert.match(defectOutput, /Received: 2/)
    }
    const evidence = join(process.cwd(), 'coverage/ci-feedback-proof')
    mkdirSync(evidence, { recursive: true })
    writeFileSync(
      join(evidence, 'native.json'),
      `${JSON.stringify(
        {
          nativeJobs: 1,
          selectedTests: 1,
          services: false,
          legacyDeficits: result.legacyDeficits.length,
          missingEvidenceRejected: true,
          wrongReturnRejectedByAssertion: true,
          durationMs: Math.round(performance.now() - started),
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
