// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Git-backed additions cannot erase production, existing-test, configuration or scheduled obligations. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { inventory, sourceFiles } from './inventory.mjs'
import { selectMutationScope } from './mutation-scope.mjs'

const cli = fileURLToPath(new URL('./mutation-cli.mjs', import.meta.url))

function repository(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-additions-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
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
  for (const [path, text] of Object.entries({
    'apps/source.ts': 'export const value = () => 42',
    'apps/other.ts': 'export const other = () => 7',
    'apps/existing.test.ts': "import {value} from './source'; value()",
    ...files,
  }))
    write(path, text)
  const base = commit()
  const scope = (overrides = {}) => {
    const entries = inventory(root)
    return selectMutationScope({
      root,
      productionFiles: sourceFiles(entries),
      testFiles: entries.filter((entry) => entry.kind === 'test').map((entry) => entry.path),
      changedFiles: git('diff', '--name-only', '--no-renames', base, 'HEAD').split('\n').filter(Boolean),
      baseSha: base,
      ...overrides,
    })
  }
  return { root, git, write, commit, base, scope }
}

function command(t, repo) {
  const evidence = mkdtempSync(join(tmpdir(), 'mutation-additions-evidence-'))
  t.after(() => rmSync(evidence, { recursive: true, force: true }))
  const head = repo.git('rev-parse', 'HEAD')
  const changedPath = join(evidence, 'changed.json')
  const comparisonPath = join(evidence, 'comparison.json')
  const output = join(evidence, 'result')
  writeFileSync(
    changedPath,
    JSON.stringify(
      repo.git('diff', '--name-only', '--no-renames', repo.base, head).split('\n').filter(Boolean),
    ),
  )
  writeFileSync(comparisonPath, JSON.stringify({ base: repo.base, head }))
  const run = ({ anchors = true, expectedHead = head } = {}) =>
    spawnSync(
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
        ...(anchors ? ['--base', repo.base, '--head', expectedHead] : []),
      ],
      { encoding: 'utf8' },
    )
  const read = (file) => JSON.parse(readFileSync(join(output, file), 'utf8'))
  return { run, read, head, changedPath, comparisonPath }
}

test('verified standalone test additions report their limited incremental obligation', (t) => {
  const repo = repository(t)
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  const head = repo.commit()
  const scope = repo.scope()
  assert.deepEqual(scope.subjects, [])
  assert.equal(scope.full, false)
  assert.equal(scope.testImpact.base, repo.base)
  assert.equal(scope.testImpact.head, head)
  assert.deepEqual(scope.testImpact.verifiedAddedTests, ['apps/new.test.ts'])
  assert.deepEqual(
    scope.testImpact.unchangedTestManifest.map(({ path }) => path),
    ['apps/existing.test.ts'],
  )
  assert.match(scope.noMutationReason, /new test strength is not certified/)
})

test('new tests cannot exempt a modified production source or helper', (t) => {
  const repo = repository(t, { 'apps/helper.ts': 'export const help = () => 1' })
  repo.write('apps/helper.ts', 'export const help = () => 2')
  repo.write('apps/new.test.ts', "import {help} from './helper'; help()")
  repo.commit()
  const scope = repo.scope()
  assert.deepEqual(scope.subjects, ['apps/helper.ts'])
  assert.deepEqual(scope.testImpact.verifiedAddedTests, ['apps/new.test.ts'])
  assert.ok(scope.testsByFile['apps/helper.ts'].includes('apps/new.test.ts'))
})

test('existing test edits retain both former and replacement imports despite new additions', (t) => {
  const repo = repository(t)
  repo.write('apps/existing.test.ts', "import {other} from './other'; other()")
  repo.write('apps/new.test.ts', "import {other} from './other'; other()")
  repo.commit()
  const scope = repo.scope()
  assert.deepEqual(scope.subjects, ['apps/other.ts', 'apps/source.ts'])
  assert.deepEqual(scope.testImpact.baseRequiredSubjects, ['apps/other.ts', 'apps/source.ts'])
})

test('deleting or renaming an existing test cannot be laundered through a new file', (t) => {
  const repo = repository(t)
  rmSync(join(repo.root, 'apps/existing.test.ts'))
  repo.write('apps/renamed.test.ts', "import {other} from './other'; other()")
  repo.commit()
  const scope = repo.scope()
  assert.equal(scope.full, false)
  assert.deepEqual(scope.subjects, ['apps/other.ts', 'apps/source.ts'])
  assert.deepEqual(scope.testImpact.verifiedAddedTests, [])
  assert.deepEqual(scope.testImpact.mappedRemovedTests, ['apps/existing.test.ts'])
})

test('deleting a test with no proven production dependencies keeps the full fallback', (t) => {
  const repo = repository(t, { 'apps/existing.test.ts': 'const existing = true' })
  rmSync(join(repo.root, 'apps/existing.test.ts'))
  repo.commit()
  const scope = repo.scope()
  assert.equal(scope.full, true)
  assert.deepEqual(scope.subjects, ['apps/other.ts', 'apps/source.ts'])
  assert.deepEqual(scope.testImpact.mappedRemovedTests, [])
})

test('deleting a test with both known and ambiguous dependencies keeps the full fallback', (t) => {
  const repo = repository(t, {
    'apps/existing.test.ts': "import {value} from './source'; import(process.env.DYNAMIC_MODULE); value()",
  })
  rmSync(join(repo.root, 'apps/existing.test.ts'))
  repo.commit()
  const scope = repo.scope()
  assert.equal(scope.full, true)
  assert.deepEqual(scope.subjects, ['apps/other.ts', 'apps/source.ts'])
  assert.deepEqual(scope.testImpact.mappedRemovedTests, [])
})

test('unknown test configuration changes still require the full inventory', (t) => {
  const repo = repository(t)
  repo.write('bunfig.toml', '[test]\nroot = "apps"\n')
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  repo.commit()
  const scope = repo.scope()
  assert.equal(scope.full, true)
  assert.deepEqual(scope.subjects, ['apps/other.ts', 'apps/source.ts'])
})

test('scheduled full runs include unchanged legacy dependencies even with verified additions', (t) => {
  const repo = repository(t)
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  repo.commit()
  const scope = repo.scope({ full: true })
  assert.equal(scope.full, true)
  assert.deepEqual(scope.subjects, ['apps/other.ts', 'apps/source.ts'])
})

test('removing all executable source cannot produce an empty passing additions scope', (t) => {
  const repo = repository(t, { 'apps/existing.test.ts': 'const existing = true' })
  rmSync(join(repo.root, 'apps/source.ts'))
  rmSync(join(repo.root, 'apps/other.ts'))
  repo.write('apps/new.test.ts', 'const added = true')
  repo.commit()
  assert.throws(() => repo.scope(), /Full mutation inventory is empty/)
})

test('omitted diff entries, omitted source inventory and dirty inputs cannot claim eligibility', (t) => {
  const repo = repository(t)
  repo.write('apps/source.ts', 'export const value = () => 43')
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  repo.commit()
  assert.throws(() => repo.scope({ changedFiles: ['apps/new.test.ts'] }), /complete base-to-head Git diff/)
  assert.throws(() => repo.scope({ productionFiles: ['apps/other.ts'] }), /inventory differs/)
  repo.write('apps/existing.test.ts', 'const noAssertions = true')
  assert.throws(() => repo.scope(), /Working tree differs/)
})

test('a caller-provided additions set cannot bypass mutation without Git proof', (t) => {
  const repo = repository(t)
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  repo.commit()
  const scope = repo.scope({ baseSha: undefined, verifiedAddedTests: new Set(['apps/new.test.ts']) })
  assert.deepEqual(scope.subjects, ['apps/source.ts'])
  assert.equal(scope.testImpact, null)
})

test('the actual CLI records verified scope rather than claiming all legacy mutations passed', (t) => {
  const repo = repository(t)
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  repo.commit()
  const probe = command(t, repo)
  const run = probe.run()
  assert.equal(run.status, 0, run.stderr)
  const summary = probe.read('summary.json')
  const scope = probe.read('scope.json')
  assert.equal(summary.passed, true)
  assert.deepEqual(summary.files, [])
  assert.match(summary.reason, /No changed production files/)
  assert.deepEqual(scope.testImpact.verifiedAddedTests, ['apps/new.test.ts'])
  assert.equal(scope.full, false)
})

test('incremental CLI cannot take its authority solely from writable comparison artifacts', (t) => {
  const repo = repository(t)
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  repo.commit()
  const probe = command(t, repo)
  const run = probe.run({ anchors: false })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /authoritative --base and --head/)
})

test('forged base=head and empty-change artifacts cannot turn an incremental check into a skip', (t) => {
  const repo = repository(t)
  repo.write('apps/source.ts', 'export const value = () => 43')
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  repo.commit()
  const probe = command(t, repo)
  writeFileSync(probe.comparisonPath, JSON.stringify({ base: probe.head, head: probe.head }))
  writeFileSync(probe.changedPath, '[]')
  const run = probe.run()
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /Comparison evidence differs from the authoritative/)
})

test('the CLI rejects missing comparison evidence instead of falling back to unverified inputs', (t) => {
  const repo = repository(t)
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  repo.commit()
  const probe = command(t, repo)
  rmSync(probe.comparisonPath)
  const run = probe.run()
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /Missing comparison evidence/)
})

test('a matching artifact cannot substitute a different checkout for the authoritative head', (t) => {
  const repo = repository(t)
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  repo.commit()
  const probe = command(t, repo)
  writeFileSync(probe.comparisonPath, JSON.stringify({ base: repo.base, head: repo.base }))
  const run = probe.run({ expectedHead: repo.base })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /checkout does not match the authoritative --head/)
})

test('a forged changed-file list is checked against the authoritative Git comparison', (t) => {
  const repo = repository(t)
  repo.write('apps/source.ts', 'export const value = () => 43')
  repo.write('apps/new.test.ts', "import {value} from './source'; value()")
  repo.commit()
  const probe = command(t, repo)
  writeFileSync(probe.changedPath, '[]')
  const run = probe.run()
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /complete base-to-head Git diff/)
})

test('renaming a test cannot waive mutation checks for changed production source', (t) => {
  const source =
    "export function advance(value: number) { if (value < 0) throw new RangeError('negative'); if (value >= 10) return 10; return value + 1 }\n"
  const strong =
    "import {expect, test} from 'bun:test'; import {advance} from './source'; test('bounds and refusal', () => { expect(() => advance(-1)).toThrow('negative'); expect(advance(0)).toBe(1); expect(advance(9)).toBe(10); expect(advance(10)).toBe(10); expect(advance(11)).toBe(10) })\n"
  const repo = repository(t, { 'apps/source.ts': source, 'apps/existing.test.ts': strong })
  repo.write('apps/source.ts', source.replace('return value + 1', 'return 1 + value'))
  rmSync(join(repo.root, 'apps/existing.test.ts'))
  repo.write(
    'apps/renamed.test.ts',
    "import {expect, test} from 'bun:test'; import {advance} from './source'; test('exists', () => { expect(advance(0)).toBeDefined(); expect(advance(10)).toBeDefined() })\n",
  )
  repo.commit()
  const scope = repo.scope()
  assert.equal(scope.full, false)
  assert.deepEqual(scope.subjects, ['apps/source.ts'])
  assert.deepEqual(scope.testImpact.verifiedAddedTests, [])
  const probe = command(t, repo)
  const run = probe.run()
  assert.ifError(run.error)
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /mutation score .* below 80/)
  const summary = probe.read('summary.json')
  assert.equal(summary.passed, false)
  assert.equal(summary.files[0].file, 'apps/source.ts')
  assert.equal(summary.files[0].total, 11)
  assert.ok(summary.files[0].score < 80)
  t.diagnostic(
    `Renamed weak test rejected: ${summary.files[0].killed}/${summary.files[0].total} mutants killed`,
  )
})
