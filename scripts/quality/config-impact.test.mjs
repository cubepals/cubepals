// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A config-only mutation waiver requires unchanged application bytes and runtime resolution. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configurationOnlyAffectsQuality, qualityOnlyChanges } from './config-impact.mjs'

function fixture() {
  const beforeManifest = {
    scripts: { test: 'bun test', gates: 'bun run lint && bun test' },
    dependencies: { runtime: '1.0.0' },
    devDependencies: { development: '1.0.0' },
  }
  const beforeLock = {
    lockfileVersion: 3,
    configVersion: 1,
    workspaces: { '': { dependencies: { runtime: '1.0.0' }, devDependencies: { development: '1.0.0' } } },
    packages: {
      runtime: ['runtime@1.0.0', '', { dependencies: { shared: '^1.0.0' } }, 'sha512-runtime'],
      development: ['development@1.0.0', '', {}, 'sha512-development'],
      shared: ['shared@1.0.0', '', {}, 'sha512-shared-original'],
    },
  }
  const afterManifest = structuredClone(beforeManifest)
  afterManifest.devDependencies['@babel/parser'] = '8.0.10'
  afterManifest.scripts['test:quality'] = 'node --test scripts/quality/*.test.mjs'
  afterManifest.scripts.gates = 'bun run lint && bun run test:quality && bun test'
  const afterLock = structuredClone(beforeLock)
  afterLock.workspaces[''].devDependencies['@babel/parser'] = '8.0.10'
  afterLock.packages['@babel/parser'] = [
    '@babel/parser@8.0.10',
    '',
    { dependencies: { shared: '^2.0.0' } },
    'sha512-parser',
  ]
  afterLock.packages['runtime/shared'] = afterLock.packages.shared
  afterLock.packages.shared = ['shared@2.0.0', '', {}, 'sha512-shared-quality']
  return { beforeManifest, afterManifest, beforeLock, afterLock }
}

const qualifies = ({ beforeManifest, afterManifest, beforeLock, afterLock }) =>
  configurationOnlyAffectsQuality(beforeManifest, afterManifest, beforeLock, afterLock)

test('quality-only tools can move a hoisted runtime dependency without changing its resolution', () => {
  assert.equal(qualifies(fixture()), true)
})

test('removing a preexisting gate or adding a fake proof command never qualifies', () => {
  const removed = fixture()
  removed.afterManifest.scripts.gates = 'bun run test:quality && bun test'
  assert.equal(qualifies(removed), false)
  const fake = fixture()
  fake.afterManifest.scripts['test:quality'] = 'true'
  assert.equal(qualifies(fake), false)
})

test('the isolated tool install command must be exact and cannot disable frozen locks', () => {
  const data = fixture()
  data.afterManifest.scripts['quality:install'] = 'bun install --cwd tools/quality --frozen-lockfile'
  data.afterManifest.scripts['test:quality'] =
    'bun run quality:install && node --test scripts/quality/*.test.mjs'
  assert.equal(qualifies(data), true)
  data.afterManifest.scripts['quality:install'] = 'bun install --cwd tools/quality'
  assert.equal(qualifies(data), false)
})

test('runtime dependency upgrades do not qualify even beside quality tools', () => {
  const data = fixture()
  data.afterManifest.dependencies.runtime = '2.0.0'
  data.afterLock.workspaces[''].dependencies.runtime = '2.0.0'
  data.afterLock.packages.runtime[0] = 'runtime@2.0.0'
  assert.equal(qualifies(data), false)
})

test('ordinary development dependencies remain protected from the mutation waiver', () => {
  const data = fixture()
  data.afterManifest.devDependencies.development = '2.0.0'
  data.afterLock.workspaces[''].devDependencies.development = '2.0.0'
  data.afterLock.packages.development[0] = 'development@2.0.0'
  assert.equal(qualifies(data), false)
})

test('changing a runtime transitive integrity hash cannot hide behind relocation', () => {
  const data = fixture()
  data.afterLock.packages['runtime/shared'][3] = 'sha512-tampered'
  assert.equal(qualifies(data), false)
})

test('adding quality tools that satisfy a previously absent runtime optional peer is not exempt', () => {
  const data = fixture()
  data.beforeLock.packages.runtime[2].peerDependencies = { '@babel/parser': '*' }
  data.afterLock.packages.runtime[2].peerDependencies = { '@babel/parser': '*' }
  assert.equal(qualifies(data), false)
})

test('unreferenced new packages, lock metadata changes, and missing dependency evidence fail closed', () => {
  const hidden = fixture()
  hidden.afterLock.packages.hidden = ['hidden@1.0.0', '', {}, 'sha512-hidden']
  assert.equal(qualifies(hidden), false)
  const metadata = fixture()
  metadata.afterLock.overrides = { runtime: 'npm:other@1.0.0' }
  assert.equal(qualifies(metadata), false)
  const absent = fixture()
  delete absent.afterLock.packages['runtime/shared']
  assert.equal(qualifies(absent), false)
})

test('a quality tool installed as a production dependency is not exempt', () => {
  const data = fixture()
  data.afterManifest.dependencies['@babel/parser'] = data.afterManifest.devDependencies['@babel/parser']
  delete data.afterManifest.devDependencies['@babel/parser']
  assert.equal(qualifies(data), false)
})

test('only config paths proved against a real base commit are returned', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-config-impact-'))
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const put = (manifest, lock) => {
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(root, 'bun.lock'), JSON.stringify(lock))
  }
  try {
    const data = fixture()
    git('init', '--quiet')
    put(data.beforeManifest, data.beforeLock)
    git('add', '.')
    git(
      '-c',
      'user.name=Quality verification',
      '-c',
      'user.email=quality@example.invalid',
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Quality fixture',
    )
    const base = git('rev-parse', 'HEAD')
    put(data.afterManifest, data.afterLock)
    assert.deepEqual(
      [...qualityOnlyChanges(root, base, ['package.json', 'bun.lock', 'src/runtime.ts'])],
      ['package.json', 'bun.lock'],
    )
    assert.deepEqual([...qualityOnlyChanges(root, 'HEAD', ['package.json', 'bun.lock'])], [])
    data.afterLock.packages['runtime/shared'][3] = 'sha512-tampered'
    put(data.afterManifest, data.afterLock)
    assert.deepEqual([...qualityOnlyChanges(root, base, ['package.json', 'bun.lock'])], [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
