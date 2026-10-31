// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A test file that only gained cases is judged as an addition; any other edit to it, however
 * small, keeps an edited test's full obligations. Unit cases cover the proof itself, and a
 * Git-backed fixture runs the real scope selection.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { inventory, sourceFiles } from './inventory.mjs'
import { selectMutationScope } from './mutation-scope.mjs'
import { appendedCases } from './test-appends.mjs'

const path = 'apps/source.test.ts'
const base = `import { expect, test } from 'bun:test'
import { advance } from './source'

const strict = (actual: number, expected: number) => expect(actual).toBe(expected)

test('bounds', () => {
  strict(advance(0), 1)
  strict(advance(9), 10)
})

test('refusal', () => {
  expect(() => advance(-1)).toThrow('negative')
})
`
const extra = `
test('ceiling', () => {
  strict(advance(10), 10)
})
`
const appended = base + extra
const proof = (head, from = base) => appendedCases(path, from, head)

test('a case added after every existing case is an addition', () => {
  assert.deepEqual(proof(appended), { appended: true, added: 1 })
  // A name added to an import the base already has, used only by the new case, is fine too.
  const named = appended
    .replace("import { expect, test } from 'bun:test'", "import { describe, expect, test } from 'bun:test'")
    .replace('strict(advance(10), 10)\n})', 'strict(advance(10), 10)\n  describe\n})')
  assert.equal(proof(named).appended, true)
})

test('editing, removing or reordering an existing case is not an addition', () => {
  assert.match(
    proof(appended.replace('strict(advance(9), 10)', 'advance(9)')).reason,
    /existing case changed/,
  )
  assert.match(
    proof(
      appended.replace("test('refusal', () => {\n  expect(() => advance(-1)).toThrow('negative')\n})\n", ''),
    ).reason,
    /existing case changed or was removed/,
  )
  // The edited case also appears unchanged elsewhere: still an edit, never a free addition.
  assert.equal(proof(appended.replace("toThrow('negative')", 'toThrow()')).appended, false)
  const early = base.replace("test('refusal'", `${extra.trim()}\n\ntest('refusal'`)
  assert.match(proof(early).reason, /runs before an existing one/)
})

test('anything beside the new cases keeps the edited-test obligations', () => {
  // A weakened helper changes what every existing case asserts.
  assert.match(
    proof(appended.replace('=> expect(actual).toBe(expected)', '=> undefined')).reason,
    /more than new cases changed/,
  )
  // Skips, focus and hooks are not plain cases, so they stay in what must match the base.
  for (const change of [
    extra.replace("test('ceiling'", "test.skip('ceiling'"),
    extra.replace("test('ceiling'", "test.only('ceiling'"),
    '\nafterAll(() => {})\n',
  ])
    assert.equal(proof(base + change).appended, false, change)
  // A new module can run code at import; an existing import's new default binding can too.
  assert.match(proof(`import './side-effect'\n${appended}`).reason, /more than new cases changed/)
  assert.match(
    proof(appended.replace("import { advance } from './source'", "import other, { advance } from './source'"))
      .reason,
    /default, namespace or renamed/,
  )
  // A newly imported name that existing code already refers to would change that code.
  const global = base.replace(
    'strict(advance(0), 1)',
    'strict(advance(0), typeof sql === "undefined" ? 1 : 2)',
  )
  const shadowed = (global + extra).replace(
    "import { expect, test } from 'bun:test'",
    "import { expect, sql, test } from 'bun:test'",
  )
  assert.match(proof(shadowed, global).reason, /existing code uses the newly imported sql/)
})

test('a base whose cases could run together, or whose after-hooks assert, is never extended', () => {
  const concurrent = base.replace("test('refusal'", "test.concurrent('refusal'")
  assert.match(proof(concurrent + extra, concurrent).reason, /concurrent/)
  const asserting = `${base}\nafterAll(() => expect(leaks).toBe(0))\n`
  assert.match(proof(asserting + extra, asserting).reason, /after-hook that could assert/)
  // A helper can assert where the hook's own text doesn't show it, and so can a passed function.
  for (const hook of [
    'afterAll(() => verifyAll())',
    'afterAll(async () => { await h.close(); check() })',
    'afterAll(verifyAll)',
    "afterAll(() => h['close']())",
  ]) {
    const withHook = `${base}\n${hook}\n`
    assert.match(proof(withHook + extra, withHook).reason, /after-hook that could assert/, hook)
  }
  // Releasing what the file set up is fine, as every database test does.
  const cleanup = `${base}\nafterAll(async () => {\n  await h.close()\n  server.stop()\n})\n`
  assert.equal(proof(cleanup + extra, cleanup).appended, true)
})

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'test-appends-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
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
  write(
    'apps/source.ts',
    "export function advance(value: number) { if (value < 0) throw new RangeError('negative'); if (value >= 10) return 10; return value + 1 }\n",
  )
  write(path, base)
  const baseSha = commit()
  const scope = () => {
    const entries = inventory(root)
    return selectMutationScope({
      root,
      productionFiles: sourceFiles(entries),
      testFiles: entries.filter((entry) => entry.kind === 'test').map((entry) => entry.path),
      changedFiles: git('diff', '--name-only', '--no-renames', baseSha, 'HEAD').split('\n').filter(Boolean),
      baseSha,
    })
  }
  return { write, commit, scope }
}

test('the real scope selection treats an extended file as an addition, and an edited one as before', (t) => {
  const extended = repository(t)
  extended.write(path, appended)
  extended.commit()
  const added = extended.scope()
  assert.deepEqual(added.testImpact.verifiedAppendedTests, [path])
  assert.deepEqual(added.subjects, [])
  assert.match(added.noMutationReason, /new test additions/)

  const edited = repository(t)
  edited.write(path, appended.replace('strict(advance(9), 10)', 'advance(9)'))
  edited.commit()
  const kept = edited.scope()
  assert.deepEqual(kept.testImpact.verifiedAppendedTests, [])
  assert.deepEqual(kept.subjects, ['apps/source.ts'])
  assert.ok(kept.reasons.some((reason) => /existing test edited, not only extended/.test(reason)))
})
