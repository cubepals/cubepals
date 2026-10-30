// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Exercises the real policy CLI against committed adversarial trees, never the working tree. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { escapeHatches, inspectChanges, qualityLock } from './policy.mjs'

const controller = fileURLToPath(new URL('./policy.mjs', import.meta.url))
const packageJson = {
  scripts: { test: 'bun test', quality: 'node scripts/quality/run.mjs' },
  devDependencies: { typescript: '7.0.2' },
}
const lock = {
  lockfileVersion: 3,
  configVersion: 1,
  workspaces: {
    '': { devDependencies: { '@stryker-mutator/core': '10.1.1' }, dependencies: { ordinary: '1.0.0' } },
  },
  packages: {
    '@stryker-mutator/core': [
      '@stryker-mutator/core@10.1.1',
      '',
      { dependencies: { engine: '^1.0.0' } },
      'sha512-core',
    ],
    engine: ['engine@1.0.0', '', { dependencies: { leaf: '^1.0.0' } }, 'sha512-engine'],
    leaf: ['leaf@1.0.0', '', {}, 'sha512-leaf'],
    ordinary: ['ordinary@1.0.0', '', {}, 'sha512-ordinary'],
  },
}

function repository(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'quality-policy-'))
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const put = (path, content) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  const commit = () => {
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
    return git('rev-parse', 'HEAD')
  }
  try {
    git('init', '--quiet')
    put('scripts/quality/policy.json', '{"branches":85,"functions":90,"lines":90}')
    put('.github/workflows/ci.yml', 'jobs:\n  check:\n    steps:\n      - run: bun test\n')
    put('bunfig.toml', '[install]\nlinker = "hoisted"\n')
    put('package.json', JSON.stringify(packageJson))
    put('bun.lock', JSON.stringify(lock))
    put('apps/example.test.ts', "test.skipIf(!database)('service', () => expect(read()).toBe(1))\n")
    put('apps/example.ts', 'export const read = () => 1\n')
    run({ cwd, put, commit, base: commit() })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function rejected(path, contents, reason) {
  repository(({ cwd, put, commit, base }) => {
    put(path, contents)
    const child = spawnSync(process.execPath, [controller, '--base', base, '--head', commit()], {
      cwd,
      encoding: 'utf8',
    })
    assert.equal(child.status, 1, child.stdout + child.stderr)
    assert.match(child.stderr, reason)
  })
}

test('the real controller accepts a behavior test and production change', () => {
  repository(({ cwd, put, commit, base }) => {
    put('apps/example.ts', 'export const read = () => 2\n')
    put('apps/contract.test.ts', "test('answer', () => expect(read()).toBe(2))\n")
    const child = spawnSync(process.execPath, [controller, '--base', base, '--head', commit()], {
      cwd,
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /preserves the trusted gate/)
  })
})

for (const [name, path, content] of [
  ['lowered threshold', 'scripts/quality/policy.json', '{"branches":0,"functions":0,"lines":0}'],
  ['coverage exclusion', 'bunfig.toml', '[test]\ncoveragePathIgnorePatterns = ["apps/**"]'],
  ['disabled workflow', '.github/workflows/ci.yml', 'jobs:\n  check:\n    steps:\n      - run: true\n'],
  [
    'additional spoofing workflow',
    '.github/workflows/spoof.yml',
    'jobs:\n  policy:\n    name: Quality policy\n    steps:\n      - run: true',
  ],
  ['replacement policy', 'scripts/quality/policy.mjs', 'process.exit(0)'],
  ['disabled Java quality tasks', 'apps/reporter/build.gradle.kts', 'tasks.test { enabled = false }'],
  ['replaced Gradle wrapper', 'apps/reporter/gradlew', '#!/bin/sh\nexit 0\n'],
  [
    'JUnit discovery configuration',
    'apps/reporter/src/test/resources/junit-platform.properties',
    'junit.jupiter.extensions.autodetection.enabled=true\n',
  ],
  [
    'Gradle execution properties',
    'apps/reporter/gradle.properties',
    'org.gradle.jvmargs=-javaagent:/tmp/agent.jar\n',
  ],
  ['Babel transform configuration', 'babel.config.js', 'export default { plugins: ["replace-tests"] }'],
  ['hidden coverage configuration', '.nycrc', '{"exclude":["**"]}'],
]) {
  test(`the real controller rejects ${name}`, () =>
    rejected(path, content, /protected quality infrastructure/))
}

test('the real controller rejects an always-success package command', () => {
  rejected(
    'package.json',
    JSON.stringify({ ...packageJson, scripts: { ...packageJson.scripts, test: 'true' } }),
    /protected test command/,
  )
})

test('an unrelated dependency update leaves the quality tool graph unchanged', () => {
  repository(({ cwd, put, commit, base }) => {
    const next = structuredClone(lock)
    next.workspaces[''].dependencies.ordinary = '2.0.0'
    next.packages.ordinary = ['ordinary@2.0.0', '', {}, 'sha512-new-ordinary']
    put('bun.lock', JSON.stringify(next))
    const child = spawnSync(process.execPath, [controller, '--base', base, '--head', commit()], {
      cwd,
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
  })
})

test('a changed transitive tool integrity hash is rejected', () => {
  const next = structuredClone(lock)
  next.packages.leaf[3] = 'sha512-replaced'
  rejected('bun.lock', JSON.stringify(next), /protected quality tool lock graph/)
})

test('a new nested tool dependency cannot shadow the trusted dependency', () => {
  const next = structuredClone(lock)
  next.packages['@stryker-mutator/core/engine'] = ['engine@2.0.0', '', {}, 'sha512-shadow']
  rejected('bun.lock', JSON.stringify(next), /protected quality tool lock graph/)
})

test('malformed lock evidence fails closed', () => {
  rejected('bun.lock', '{"packages":{}}', /quality tool lock cannot be verified/)
})

test('Bun trailing commas are parsed without executing lockfile contents', () => {
  const withCommas = JSON.stringify(lock, null, 2).replace(/\n(\s*)}/g, ',\n$1}')
  assert.deepEqual(qualityLock(withCommas), qualityLock(JSON.stringify(lock)))
})

test('the real controller rejects changing a skip condition to true', () => {
  rejected(
    'apps/example.test.ts',
    "test.skipIf(true)('service', () => expect(read()).toBe(1))\n",
    /added test modifier/,
  )
})

for (const modifier of ['only', 'skip', 'todo', 'failing']) {
  test(`the real controller rejects ${modifier} tests`, () => {
    rejected(
      'apps/weak.test.ts',
      `test['${modifier}']('answer', () => expect(read()).toBe(1))`,
      /added test modifier/,
    )
  })
}

test('the real controller rejects source coverage ignore directives', () => {
  rejected('apps/example.ts', '/* istanbul ignore next */\nexport const read = () => 1', /added ignore/)
})

test('the real controller rejects disabled Java cases and test assumptions', () => {
  const path = 'apps/reporter/src/test/java/blockly/reporter/WeakTest.java'
  rejected(path, '@org.junit.jupiter.api.Disabled class WeakTest {}', /added disabled Java test/)
  rejected(
    path,
    '@EnabledIfEnvironmentVariable(named="ALLOW", matches="yes") class WeakTest {}',
    /added disabled Java test/,
  )
  rejected(path, 'class WeakTest { void check() { assumeTrue(false); } }', /added conditional Java test/)
})

test('the real controller rejects mutant-aware assertions', () => {
  rejected(
    'apps/aware.test.ts',
    "test('answer', () => expect(process.env['__STRYKER_ACTIVE_MUTANT__'] ? false : true).toBe(true))",
    /added evidence access: __STRYKER_ACTIVE_MUTANT__/,
  )
})

test('the real controller rejects assigning fabricated coverage counters', () => {
  rejected(
    'apps/example.ts',
    'globalThis.__qualityCoverage__ = { fake: { s: { 0: 999999 }, f: { 0: 999999 }, b: { 0: [999999, 999999] } } }',
    /added evidence access: __qualityCoverage__/,
  )
})

for (const name of [
  '__coverage__',
  '__stryker__',
  'STRYKER_ACTIVE_MUTANT',
  'QUALITY_REPORT',
  'QUALITY_ROOT',
  'QUALITY_SHARD',
]) {
  test(`the real controller rejects quoted evidence access to ${name}`, () => {
    rejected('apps/evidence.test.ts', `const evidence = process.env['${name}']`, /added evidence access:/)
  })
}

test('existing evidence references are frozen by occurrence count; comments are not access', () => {
  const source = 'const path = process.env.QUALITY_REPORT\n'
  assert.deepEqual(
    inspectChanges([
      { path: 'a.ts', before: source, after: `${source}// QUALITY_REPORT names the evidence file\n` },
    ]),
    [],
  )
  assert.match(
    inspectChanges([{ path: 'a.ts', before: source, after: source + source }]).join('\n'),
    /added evidence access/,
  )
})

test('fixture strings and documentation text are not executable modifiers or directives', () => {
  assert.deepEqual(
    escapeHatches(`const fixture = "test.skip('later')"; const comment = '/* istanbul ignore next */'`, true),
    [],
  )
})

test('unchanged conditional skips remain allowed; copying one adds a forbidden occurrence', () => {
  const source = "test.skipIf(!database)('service', () => expect(read()).toBe(1))\n"
  assert.deepEqual(
    inspectChanges([
      { path: 'a.test.ts', before: source, after: `${source}test('new', () => expect(read()).toBe(1))` },
    ]),
    [],
  )
  assert.match(
    inspectChanges([{ path: 'a.test.ts', before: source, after: source + source }]).join('\n'),
    /added test modifier/,
  )
})

test('refs are hashes, never arbitrary git options', () => {
  const child = spawnSync(process.execPath, [controller, '--base', '--help', '--head', 'main'], {
    encoding: 'utf8',
  })
  assert.equal(child.status, 1)
  assert.match(child.stderr, /full commit hash/)
})
