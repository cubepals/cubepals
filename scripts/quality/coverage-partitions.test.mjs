// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real Bun processes produce partition evidence; missing, duplicate and stale reports fail. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { mergeNativePartitions } from './coverage-partitions.mjs'
import { nativePartitions, selectedTests, testPlan } from './partition-plan.mjs'
import { runShard } from './run-shard.mjs'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'quality-native-partitions-'))
  const root = join(directory, 'head'),
    baseRoot = join(directory, 'base'),
    reports = join(directory, 'reports')
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  put('apps/value.ts', 'export function value(flag: boolean) { return flag ? 1 : 0 }\n')
  put('scripts/quality/runtime-costs.json', JSON.stringify({ tests: {}, mutations: {} }))
  const paths = {
    lifecycle: 'apps/control/src/app/operations',
    providers: 'apps/control/src/infra/fly',
    worlds: 'apps/control/src/app/worlds',
    mods: 'apps/control/src/app/mods',
    access: 'apps/control/src/app/access',
    web: 'apps/web',
    rest: 'apps/control/src/interfaces',
  }
  for (const [group, count] of Object.entries(nativePartitions)) {
    for (let i = 0; i < count; i++) {
      const path = `${paths[group]}/partition-${i}.test.ts`
      let module = relative(dirname(path), 'apps/value.ts')
      if (!module.startsWith('.')) module = `./${module}`
      put(
        path,
        `import {test,expect} from 'bun:test'; import {value} from ${JSON.stringify(module)}; test('both branches',()=>{expect(value(true)).toBe(1);expect(value(false)).toBe(0)})\n`,
      )
    }
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '--template=', '-b', 'main')
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
  const base = git('rev-parse', 'HEAD')
  git('worktree', 'add', '--detach', baseRoot, base)
  const plan = testPlan(root, base)
  for (const [group, count] of Object.entries(nativePartitions)) {
    for (let partition = 0; partition < count; partition++) {
      runShard({ root: baseRoot, group, reportDir: join(reports, 'base'), plan, partition })
      runShard({
        root,
        group,
        reportDir: join(reports, 'head'),
        plan,
        partition,
        baseManifest: join(reports, 'base', 'manifests', `${group}-${partition}.json`),
      })
    }
  }
  return { directory, root, baseRoot, reports, base, plan }
}

test('real parallel-partition evidence is exhaustive, and tampering cannot hide missing work', () => {
  const previous = { ...process.env }
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://localhost/fixture',
    NATS_TEST_URL: 'nats://localhost:4222',
    S3_TEST_ENDPOINT: 'http://localhost:9000',
    S3_TEST_BUCKET: 'fixture',
    PEBBLE_TEST_URL: 'https://localhost:14000',
    CHALLTESTSRV_TEST_URL: 'http://localhost:8055',
    MC_ROUTER_BIN: '/fixture/not-used',
  })
  let f
  try {
    f = fixture()
    const args = { root: f.root, baseRoot: f.baseRoot, directory: f.reports, base: f.base }
    mergeNativePartitions(args)
    const merged = JSON.parse(readFileSync(join(f.reports, 'merged/head/lifecycle.json')))
    assert.deepEqual(merged.shards, ['lifecycle'])
    assert.ok(Object.values(merged.files['apps/value.ts'].f).every((count) => count > 0))
    const path = join(f.reports, 'head/manifests/lifecycle-0.json'),
      original = readFileSync(path, 'utf8')
    const manifest = JSON.parse(original)
    manifest.tests[0].sha256 = '0'.repeat(64)
    writeFileSync(path, JSON.stringify(manifest))
    assert.throws(() => mergeNativePartitions(args), /stale partition test/)
    writeFileSync(path, original)
    manifest.tests[0] = JSON.parse(readFileSync(join(f.reports, 'head/manifests/lifecycle-1.json'))).tests[0]
    writeFileSync(path, JSON.stringify(manifest))
    assert.throws(() => mergeNativePartitions(args), /foreign partition tests/)
    writeFileSync(path, original)
    const report = join(f.reports, 'head/lifecycle-1.json')
    rmSync(report)
    assert.throws(() => mergeNativePartitions(args), /ENOENT/)
    const tests = f.plan.groups.lifecycle.headTests
    assert.throws(() => selectedTests(f.plan, f.root, 'lifecycle', 0, tests.slice(1)), /inventory differs/)
    assert.throws(
      () =>
        selectedTests(
          { ...f.plan, base: '0'.repeat(40), head: '1'.repeat(40) },
          f.root,
          'lifecycle',
          0,
          tests,
        ),
      /Foreign/,
    )
  } finally {
    if (f) rmSync(f.directory, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]
    Object.assign(process.env, previous)
  }
})
