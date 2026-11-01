// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A dependency-only update is judged by what it can break, never by legacy debt, and nothing else
 * can ride along with it. Git-backed fixtures run the real scope selection and the real CLI.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MINUTE_MS } from '../../packages/contracts/src/durations.ts'
import { baselineComparison } from './coverage-impact.mjs'
import { dependencyOnlyChange } from './dependency-impact.mjs'
import { inventory, sourceFiles } from './inventory.mjs'
import { selectMutationScope } from './mutation-scope.mjs'

const cli = fileURLToPath(new URL('./mutation-cli.mjs', import.meta.url))

const integrity = (text) => `sha512-${Buffer.from(text.padEnd(64, '=')).toString('base64')}`
const record = (name, version, extra = {}) => [
  `${name}@${version}`,
  '',
  extra,
  integrity(`${name}${version}`),
]

const strictChecker =
  'export function same(actual, expected) { if (actual !== expected) throw new Error("mismatch") }\n'
const vacuousChecker = 'export function same() {}\n'
const source =
  "import { now } from 'clock'\nexport function advance(value: number) { if (value < 0) throw new RangeError('negative'); if (value >= 10) return 10; return value + 1 }\nexport const stamp = () => now()\n"
const strongTest =
  "import { expect, test } from 'bun:test'\nimport { same } from 'checker'\nimport { advance } from './source'\ntest('bounds and refusal', () => { expect(() => advance(-1)).toThrow('negative'); same(advance(0), 1); same(advance(9), 10); same(advance(10), 10); same(advance(11), 10) })\n"
const weakTest =
  "import { expect, test } from 'bun:test'\nimport { advance } from './source'\ntest('exists', () => { expect(advance(0)).toBeDefined() })\n"

function versions({ clock = '1.0.0', checker = '1.0.0', types = '1.0.0' } = {}) {
  const manifest = {
    name: 'fixture',
    private: true,
    dependencies: { clock, checker, 'checker-types': types },
  }
  const lock = {
    lockfileVersion: 3,
    configVersion: 1,
    workspaces: { '': { name: 'fixture', dependencies: manifest.dependencies } },
    packages: {
      clock: record('clock', clock),
      checker: record('checker', checker, { peerDependencies: { 'checker-types': '*' } }),
      'checker-types': record('checker-types', types),
    },
  }
  return { manifest, lock }
}

/** Installs the fixture's packages where Bun's hoisted linker would put them. */
function install(root, { checker = strictChecker, types = '1.0.0', checkerVersion = '1.0.0' } = {}) {
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  put('node_modules/clock/package.json', JSON.stringify({ name: 'clock', version: '1.0.0', type: 'module' }))
  put('node_modules/clock/index.js', 'export const now = () => 0\n')
  put(
    'node_modules/checker/package.json',
    JSON.stringify({ name: 'checker', version: checkerVersion, type: 'module', main: 'index.js' }),
  )
  put('node_modules/checker/index.js', checker)
  put('node_modules/checker-types/package.json', JSON.stringify({ name: 'checker-types', version: types }))
  put('node_modules/checker-types/index.d.ts', 'export declare function same(a: unknown, b: unknown): void\n')
  put('node_modules/checker-types/README.md', 'Types only.\n')
}

function repository(t, { entry = true, extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dependency-impact-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const pin = (options) => {
    const { manifest, lock } = versions(options)
    write('package.json', `${JSON.stringify(manifest, null, 2)}\n`)
    write('bun.lock', `${JSON.stringify(lock, null, 2)}\n`)
  }
  git('init', '--quiet', '--template=', '-b', 'fixture')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'user.name', 'Quality fixture')
  git('config', 'user.email', 'quality@example.invalid')
  const commit = () => {
    git('add', '--all')
    git('commit', '--quiet', '--no-gpg-sign', '-m', 'Fixture change')
    return git('rev-parse', 'HEAD')
  }
  write('.gitignore', 'node_modules/\n')
  write('apps/source.ts', source)
  if (entry) write('apps/main.ts', "import { advance } from './source'\nadvance(0)\n")
  write('apps/existing.test.ts', strongTest)
  for (const [path, content] of Object.entries(extra)) write(path, content)
  pin()
  install(root)
  const base = commit()
  const changed = () => git('diff', '--name-only', '--no-renames', base, 'HEAD').split('\n').filter(Boolean)
  const scope = () => {
    const entries = inventory(root)
    return selectMutationScope({
      root,
      productionFiles: sourceFiles(entries),
      testFiles: entries.filter((entry) => entry.kind === 'test').map((entry) => entry.path),
      changedFiles: changed(),
      baseSha: base,
    })
  }
  const reset = () => git('reset', '--quiet', '--hard', base)
  return { root, git, write, pin, commit, base, changed, scope, reset }
}

/** The real CLI with authoritative anchors, optionally measuring a base worktree. */
function command(t, repo, { baseRoot } = {}) {
  const evidence = mkdtempSync(join(tmpdir(), 'dependency-impact-evidence-'))
  t.after(() => rmSync(evidence, { recursive: true, force: true }))
  const head = repo.git('rev-parse', 'HEAD')
  const changedPath = join(evidence, 'changed.json')
  writeFileSync(changedPath, JSON.stringify(repo.changed()))
  writeFileSync(join(evidence, 'comparison.json'), JSON.stringify({ base: repo.base, head }))
  const output = join(evidence, 'result')
  const run = spawnSync(
    process.execPath,
    [
      cli,
      '--root',
      repo.root,
      '--changed',
      changedPath,
      '--group',
      'rest',
      '--output',
      output,
      '--base',
      repo.base,
      '--head',
      head,
      ...(baseRoot ? ['--base-root', baseRoot] : []),
    ],
    { encoding: 'utf8', timeout: 10 * MINUTE_MS },
  )
  const read = (file) => JSON.parse(readFileSync(join(output, file), 'utf8'))
  return { run, read }
}

/** A checkout of the base commit with the base revision's packages installed. */
function baseWorktree(t, repo, packages) {
  const path = mkdtempSync(join(tmpdir(), 'dependency-impact-base-'))
  rmSync(path, { recursive: true, force: true })
  repo.git('worktree', 'add', '--quiet', '--detach', path, repo.base)
  t.after(() => rmSync(path, { recursive: true, force: true }))
  install(path, packages)
  return path
}

test('a lockfile-only update holds no unchanged file to the new-code floor', (t) => {
  const repo = repository(t)
  repo.pin({ clock: '1.1.0' })
  repo.commit()
  const scope = repo.scope()
  assert.equal(scope.full, false)
  assert.deepEqual(scope.subjects, [])
  assert.equal(scope.testImpact.dependencyOnly.eligible, true)
  assert.deepEqual(scope.testImpact.dependencyOnly.changedPackages, ['clock'])
  assert.deepEqual(scope.baseScore.oracleTests, [])
  assert.match(scope.noMutationReason, /Dependency-only update/)
  assert.ok(!scope.reasons.some((reason) => /configuration changed|fixture or data/.test(reason)))
  const probe = command(t, repo)
  assert.equal(probe.run.status, 0, probe.run.stderr)
  assert.equal(probe.read('summary.json').passed, true)
  assert.deepEqual(probe.read('summary.json').files, [])
})

test('changed production alongside a dependency bump still rejects weak assertions', (t) => {
  const repo = repository(t, { entry: false })
  repo.pin({ clock: '1.1.0' })
  repo.write('apps/existing.test.ts', weakTest)
  repo.write('apps/source.ts', source.replace('return value + 1', 'return 1 + value'))
  repo.commit()
  const scope = repo.scope()
  assert.equal(scope.testImpact.dependencyOnly.eligible, false)
  assert.match(scope.testImpact.dependencyOnly.reason, /not dependency files: apps\/existing\.test\.ts/)
  assert.equal(scope.full, true)
  assert.equal(scope.baseScore, null)
  assert.ok(scope.subjects.includes('apps/source.ts'))
  assert.ok(scope.reasons.some((reason) => /configuration changed: bun\.lock/.test(reason)))
  const probe = command(t, repo)
  assert.notEqual(probe.run.status, 0)
  assert.match(probe.run.stderr, /below 80/)
  const row = probe.read('summary.json').files.find((file) => file.file === 'apps/source.ts')
  assert.equal(row.threshold, 80)
  assert.ok(row.score < 80)
})

test('dependency coverage scope is preserved while release mutations stay empty', (t) => {
  const repo = repository(t)
  repo.pin({ checker: '1.1.0' })
  repo.commit()
  const scope = repo.scope()
  assert.equal(scope.full, false)
  assert.deepEqual(scope.baseScore, { subjects: ['apps/source.ts'], oracleTests: ['apps/existing.test.ts'] })
  assert.deepEqual(scope.subjects, ['apps/source.ts'])
  assert.deepEqual(scope.testsByFile['apps/source.ts'], ['apps/existing.test.ts'])
  assert.deepEqual(scope.additionalTestsByFile['apps/source.ts'], [])
  const probe = command(t, repo)
  assert.equal(probe.run.status, 0, probe.run.stderr)
  assert.deepEqual(probe.read('summary.json').files, [])
  assert.equal(probe.read('scope.json').baseScore, null)
})

test('dependency coverage comparisons retain affected oracles without unrelated timing samples', (t) => {
  for (const [name, expected] of [
    ['checker', ['apps/source.ts']],
    ['clock', []],
  ]) {
    const repo = repository(t)
    repo.pin({ [name]: '1.1.0' })
    const head = repo.commit()
    const scope = repo.scope()
    const comparison = baselineComparison(
      repo.root,
      { base: repo.base, head },
      repo.changed(),
      inventory(repo.root),
      scope.testImpact.baseInventory,
    )
    assert.deepEqual(comparison.files, expected)
    assert.match(comparison.reason, /dependency-only/)
  }
})

test('dependency oracles do not parse imported runtime JSON as executable source', (t) => {
  const repo = repository(t, {
    extra: {
      'apps/input.json': '{"value":10}',
      'apps/source.ts': `import data from './input.json' with {type:'json'};\n${source}\nexport const label=data.value;`,
    },
  })
  repo.pin({ checker: '1.1.0' })
  const head = repo.commit()
  const scope = repo.scope()
  assert.deepEqual(scope.subjects, ['apps/source.ts'])
  assert.ok(scope.subjects.every((path) => !path.endsWith('.json')))
  const comparison = baselineComparison(
    repo.root,
    { base: repo.base, head },
    repo.changed(),
    inventory(repo.root),
    scope.testImpact.baseInventory,
  )
  assert.deepEqual(comparison.files, ['apps/source.ts'])
})

test('changed production rejects a weakened dependency oracle and accepts a detecting one', (t) => {
  for (const weak of [true, false]) {
    const repo = repository(t)
    repo.pin({ checker: '1.1.0' })
    install(repo.root, { checker: weak ? vacuousChecker : strictChecker, checkerVersion: '1.1.0' })
    repo.write('apps/source.ts', source.replace('return value + 1', 'return 1 + value'))
    repo.commit()
    const result = command(t, repo)
    const row = result.read('summary.json').files[0]
    assert.equal(row.file, 'apps/source.ts')
    assert.equal(row.threshold, 80)
    if (weak) {
      assert.notEqual(result.run.status, 0)
      assert.ok(row.score < 80)
    } else {
      assert.equal(result.run.status, 0, result.run.stderr)
      assert.ok(row.score >= 80)
    }
  }
})

test('unchanged production does not require a mutation baseline checkout', (t) => {
  const repo = repository(t)
  repo.pin({ checker: '1.1.0' })
  repo.commit()
  const elsewhere = mkdtempSync(join(tmpdir(), 'dependency-impact-elsewhere-'))
  rmSync(elsewhere, { recursive: true, force: true })
  repo.git('worktree', 'add', '--quiet', '--detach', elsewhere, 'HEAD')
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }))
  const probe = command(t, repo, { baseRoot: elsewhere })
  assert.equal(probe.run.status, 0, probe.run.stderr)
  assert.deepEqual(probe.read('summary.json').files, [])
})

test('a package whose install is only declarations affects nothing, even a test oracle', (t) => {
  const repo = repository(t)
  repo.pin({ types: '1.1.0' })
  install(repo.root, { types: '1.1.0' })
  repo.commit()
  const proof = dependencyOnlyChange(repo.root, repo.base, repo.changed())
  assert.equal(proof.eligible, true)
  assert.deepEqual(proof.declarationPackages, ['checker-types'])
  assert.deepEqual(proof.affectedPackages, [])
  assert.deepEqual(repo.scope().subjects, [])

  // The same bump with runnable files, or an install of another version, is not inert, and
  // reaches checker through its peer.
  writeFileSync(join(repo.root, 'node_modules/checker-types/index.js'), 'export {}\n')
  assert.deepEqual(dependencyOnlyChange(repo.root, repo.base, repo.changed()).affectedPackages, [
    'checker',
    'checker-types',
  ])
  rmSync(join(repo.root, 'node_modules/checker-types/index.js'))
  // JSON other than package.json is data a test can import, not a declaration.
  writeFileSync(join(repo.root, 'node_modules/checker-types/data.json'), '{"limit": 10}\n')
  assert.deepEqual(dependencyOnlyChange(repo.root, repo.base, repo.changed()).declarationPackages, [])
  rmSync(join(repo.root, 'node_modules/checker-types/data.json'))
  // A script run at install time is not a shipped file, so it is checked on its own.
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    const manifest = join(repo.root, 'node_modules/checker-types/package.json')
    writeFileSync(
      manifest,
      JSON.stringify({ name: 'checker-types', version: '1.1.0', scripts: { [script]: 'true' } }),
    )
    assert.deepEqual(
      dependencyOnlyChange(repo.root, repo.base, repo.changed()).declarationPackages,
      [],
      script,
    )
  }
  // Scripts that run only in the package's own repository, such as build or test, are not run here.
  writeFileSync(
    join(repo.root, 'node_modules/checker-types/package.json'),
    JSON.stringify({ name: 'checker-types', version: '1.1.0', scripts: { build: 'tsc', test: 'tsc' } }),
  )
  assert.deepEqual(dependencyOnlyChange(repo.root, repo.base, repo.changed()).declarationPackages, [
    'checker-types',
  ])
  install(repo.root, { types: '1.0.0' })
  assert.deepEqual(dependencyOnlyChange(repo.root, repo.base, repo.changed()).declarationPackages, [])
})

test('only registry version moves qualify as a dependency-only update', (t) => {
  const repo = repository(t)
  const refusal = (change) => {
    repo.reset()
    change()
    repo.commit()
    const proof = dependencyOnlyChange(repo.root, repo.base, repo.changed())
    assert.equal(proof.eligible, false)
    return proof.reason
  }
  const edit = (path, mutate) => {
    const value = JSON.parse(readFileSync(join(repo.root, path), 'utf8'))
    mutate(value)
    repo.write(path, `${JSON.stringify(value, null, 2)}\n`)
  }
  const bump = () => repo.pin({ clock: '1.1.0' })
  assert.match(
    refusal(() => {
      bump()
      edit('package.json', (manifest) => {
        manifest.scripts = { test: 'bun test --bail' }
      })
    }),
    /more than versions changed/,
  )
  assert.match(
    refusal(() => {
      bump()
      edit('package.json', (manifest) => {
        manifest.dependencies.extra = '1.0.0'
      })
    }),
    /adds or removes a package/,
  )
  assert.match(
    refusal(() => {
      bump()
      edit('package.json', (manifest) => {
        manifest.dependencies.clock = 'github:someone/clock'
      })
    }),
    /not a registry version/,
  )
  assert.match(
    refusal(() => {
      bump()
      edit('bun.lock', (lock) => {
        lock.packages.clock = ['clock@1.1.0', 'https://elsewhere.invalid/clock.tgz', {}, integrity('x')]
      })
    }),
    /registry tarball/,
  )
  assert.match(
    refusal(() => {
      bump()
      edit('bun.lock', (lock) => {
        lock.packages.clock = ['clock@1.1.0', '', {}]
      })
    }),
    /registry tarball/,
  )
  assert.match(
    refusal(() => {
      bump()
      edit('bun.lock', (lock) => {
        lock.overrides = { clock: '1.1.0' }
      })
    }),
    /settings, overrides or patches/,
  )
  assert.match(
    refusal(() => {
      bump()
      edit('bun.lock', (lock) => {
        lock.workspaces[''].dependencies.clock = '1.2.0'
      })
    }),
    /disagrees with the root package\.json/,
  )
  assert.match(
    refusal(() => {
      bump()
      repo.write('bunfig.toml', '[test]\npreload = ["./apps/setup.ts"]\n')
    }),
    /not dependency files: bunfig\.toml/,
  )
  assert.match(
    refusal(() => edit('package.json', (manifest) => (manifest.dependencies.clock = '1.1.0'))),
    /bun\.lock did not change/,
  )
})
