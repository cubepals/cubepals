// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real Bun baseline data may be reused; stale, foreign and tampered data never replace tests. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, before, test } from 'node:test'
import { DAY_MS, HOUR_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { revalidateBaseline } from './baseline-cache.mjs'
import { packBaseline, validateBaseline } from './baseline-evidence.mjs'
import { baselineIdentity, cacheAllowed, trustedProducer } from './baseline-identity.mjs'
import { runShard } from './run-shard.mjs'
import { groups } from './shards.mjs'

const at = new Date(Date.UTC(2026, 0, 2, 12))
const producer = {
  id: 123,
  head: '',
  branch: 'main',
  event: 'push',
  workflow: '.github/workflows/ci.yml',
  repository: 'fixtures/repo',
  repositoryId: 1,
  conclusion: 'success',
}
let f
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'quality-baseline-cache-'))
  const root = join(directory, 'head'),
    baseRoot = join(directory, 'base'),
    data = join(directory, 'measurements'),
    archive = join(directory, 'archive')
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  put('apps/value.ts', 'export function value(flag: boolean) { return flag ? 1 : 0 }\n')
  put('package.json', '{"type":"module"}\n')
  const paths = {
    lifecycle: 'apps/control/src/app/operations',
    providers: 'apps/control/src/infra/fly',
    worlds: 'apps/control/src/app/worlds',
    mods: 'apps/control/src/app/mods',
    access: 'apps/control/src/app/access',
    web: 'apps/web',
    rest: 'apps/control/src/interfaces',
  }
  for (const [group, parent] of Object.entries(paths)) {
    let module = relative(parent, 'apps/value.ts')
    if (!module.startsWith('.')) module = `./${module}`
    put(
      `${parent}/baseline.test.ts`,
      `import {test,expect} from 'bun:test';import{value}from ${JSON.stringify(module)};test('${group}',()=>{expect(value(true)).toBe(1);expect(value(false)).toBe(0)})\n`,
    )
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
  const source = git('rev-parse', 'HEAD')
  producer.head = source
  git('worktree', 'add', '--detach', baseRoot, source)
  for (const group of Object.keys(groups)) {
    runShard({ root, group, reportDir: data })
    const path = join(data, 'manifests', `${group}.json`),
      manifest = read(path)
    // Only the protocol's timestamp inputs are fixed; counters and JUnit come from real Bun.
    manifest.startedAt = new Date(+at - SECOND_MS).toISOString()
    manifest.completedAt = at.toISOString()
    writeFileSync(path, JSON.stringify(manifest))
  }
  const identity = packBaseline({ root, checkout: baseRoot, directory: data, output: archive, producer, at })
  writeFileSync(
    join(archive, 'origin.json'),
    JSON.stringify({
      identity,
      producer,
      repository: producer.repository,
      repositoryId: producer.repositoryId,
    }),
  )
  return { directory, root, baseRoot, data, archive, identity, git }
}

before(() => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://localhost/fixture',
    NATS_TEST_URL: 'nats://localhost:4222',
    S3_TEST_ENDPOINT: 'http://localhost:9000',
    S3_TEST_BUCKET: 'fixture',
    PEBBLE_TEST_URL: 'https://localhost:14000',
    CHALLTESTSRV_TEST_URL: 'http://localhost:8055',
    MC_ROUTER_BIN: '/fixture/not-used',
  })
  f = fixture()
})
after(() => {
  if (f) rmSync(f.directory, { recursive: true, force: true })
})

const validate = (overrides = {}) =>
  validateBaseline({
    root: f.root,
    checkout: f.baseRoot,
    directory: f.archive,
    identity: f.identity,
    producer,
    repository: producer.repository,
    repositoryId: producer.repositoryId,
    at,
    ...overrides,
  })

test('a complete real seven-group baseline retains source, test and counter identity', () => {
  assert.equal(validate().source, f.identity.source)
})

test('PRs, other repositories, failed runs and other workflows cannot be cache producers', () => {
  for (const change of [
    { branch: 'feature' },
    { event: 'pull_request' },
    { conclusion: 'failure' },
    { repository: 'other/repo' },
    { repositoryId: 2 },
    { workflow: '.github/workflows/other.yml' },
  ]) {
    assert.equal(
      trustedProducer({ ...producer, ...change }, producer.repository, producer.repositoryId),
      false,
    )
    assert.throws(() => validate({ producer: { ...producer, ...change } }), /not a successful main/)
  }
})

test('the server producer identity cannot be replaced by downloaded metadata', () => {
  assert.throws(() => validate({ producer: { ...producer, id: 999 } }), /producer mismatch/)
})

test('changed tooling, dependencies, runtime or calendar invalidate reuse', () => {
  const path = join(f.root, 'package.json'),
    previous = readFileSync(path, 'utf8')
  try {
    writeFileSync(path, '{"type":"module","changed":true}\n')
    assert.throws(
      () => validate({ identity: baselineIdentity(f.root, f.identity.source, at) }),
      /identity mismatch/,
    )
  } finally {
    writeFileSync(path, previous)
  }
  assert.throws(
    () => validate({ identity: { ...f.identity, fingerprint: '0'.repeat(64) } }),
    /identity mismatch/,
  )
  assert.throws(
    () => validate({ identity: baselineIdentity(f.root, f.identity.source, new Date(+at + DAY_MS)) }),
    /identity mismatch/,
  )
})

test('expired baseline measurements fail even when their source and tooling still match', () => {
  assert.throws(() => validate({ at: new Date(+at + 4 * HOUR_MS) }), /Expired baseline/)
})

test('changed source and changed test bytes cannot borrow an old baseline', () => {
  for (const file of ['apps/value.ts', 'apps/web/baseline.test.ts']) {
    const path = join(f.baseRoot, file),
      previous = readFileSync(path, 'utf8')
    try {
      writeFileSync(path, `${previous}\n// changed\n`)
      assert.throws(() => validate(), /inventory/)
    } finally {
      writeFileSync(path, previous)
    }
  }
})

test('internally valid counter edits are caught by the immutable dataset digest', () => {
  const path = join(f.archive, 'data/web.json'),
    previous = readFileSync(path, 'utf8')
  try {
    const report = JSON.parse(previous),
      file = report.files['apps/value.ts']
    const key = Object.keys(file.f)[0]
    file.f[key] += 1
    writeFileSync(path, JSON.stringify(report))
    assert.throws(() => validate(), /digest mismatch/)
  } finally {
    writeFileSync(path, previous)
  }
})

test('omitted baseline evidence cannot turn into an empty passing cache', () => {
  const path = join(f.archive, 'data/web.json'),
    previous = readFileSync(path, 'utf8')
  try {
    rmSync(path)
    assert.throws(() => validate(), /Missing or foreign/)
  } finally {
    writeFileSync(path, previous)
  }
})

test('cached identity data cannot override a newly computed current identity', () => {
  const path = join(f.root, 'package.json'),
    previous = readFileSync(path, 'utf8')
  try {
    writeFileSync(path, '{"type":"module","changed":true}\n')
    assert.throws(
      () => revalidateBaseline({ root: f.root, checkout: f.baseRoot, directory: f.archive }),
      /identity mismatch/,
    )
  } finally {
    writeFileSync(path, previous)
  }
})

test('head failures still execute and fail after a valid cached baseline', () => {
  assert.equal(validate().source, f.identity.source)
  const path = join(f.root, 'apps/value.ts'),
    previous = readFileSync(path, 'utf8')
  try {
    writeFileSync(path, 'export function value(flag: boolean) { return flag ? 2 : 0 }\n')
    assert.throws(
      () =>
        runShard({
          root: f.root,
          group: 'web',
          reportDir: join(f.directory, 'failed-head'),
          baseManifest: join(f.archive, 'data/manifests/web.json'),
        }),
      /Test file .* failed/,
    )
  } finally {
    writeFileSync(path, previous)
  }
})

test('conservative clock boundaries use fresh measurements', () => {
  assert.equal(cacheAllowed(new Date(Date.UTC(2026, 0, 1, 12))), false)
  assert.equal(cacheAllowed(new Date(Date.UTC(2026, 0, 2, 23))), false)
  assert.equal(cacheAllowed(at), true)
})
