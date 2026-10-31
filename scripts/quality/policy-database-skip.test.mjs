// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A new test file may skip where no Postgres is given, with exactly `describe.skipIf(!hasDatabase)`
 * and only when it starts the database harness. Every other new skip is still refused, and CI's
 * JUnit evidence still refuses a case that skips.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkJUnit } from './coverage-junit.mjs'
import { databaseSkipAllowed, inspectChanges } from './policy.mjs'

const path = 'apps/control/src/app/operations/session-cap-claims.test.ts'
const file = `import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

describe.skipIf(!hasDatabase)('session warning claims', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness()
  })
  afterAll(() => h.close())
  test('says nothing', () => {
    expect(h).toBeDefined()
  })
})
`
const errors = (after, { at = path, before = null } = {}) =>
  inspectChanges([{ path: at, before, after, modeBefore: undefined, modeAfter: '100644' }])

test('a new database test file may skip where no Postgres is given', () => {
  assert.equal(databaseSkipAllowed(path, file), true)
  assert.deepEqual(errors(file), [])
})

test('any other skip expression is still refused', () => {
  for (const [from, to] of [
    ['describe.skipIf(!hasDatabase)', 'describe.skipIf(!process.env.DATABASE_URL)'],
    ['describe.skipIf(!hasDatabase)', 'describe.skipIf(hasDatabase)'],
    ['describe.skipIf(!hasDatabase)', 'describe.skipIf(!hasDatabase || true)'],
    ['describe.skipIf(!hasDatabase)', 'test.skipIf(!hasDatabase)'],
    ['describe.skipIf(!hasDatabase)', 'describe.runIf(hasDatabase)'],
  ]) {
    const changed = file.replace(from, to)
    assert.match(errors(changed).join('\n'), /added test modifier/, to)
  }
  // Two of them, or the one beside another skip, is more than the one allowed.
  const twice = `${file}\ndescribe.skipIf(!hasDatabase)('again', () => {})\n`
  assert.match(errors(twice).join('\n'), /added test modifier/)
  const beside = file.replace("test('says nothing'", "test.skip('says nothing'")
  assert.match(errors(beside).join('\n'), /added test modifier/)
})

test('a test that does not need the database may not skip without one', () => {
  // It never starts the harness: nothing in it needs Postgres.
  const noHarness = file.replace('h = await startHarness()', 'h = {} as Harness')
  assert.match(errors(noHarness).join('\n'), /added test modifier/)
  // hasDatabase must be the harness's own, not a renamed or local stand-in that is always false.
  const local = file
    .replace('hasDatabase, startHarness', 'startHarness')
    .replace('describe.skipIf', 'const hasDatabase = false\ndescribe.skipIf')
  assert.match(errors(local).join('\n'), /added test modifier/)
  const renamed = file
    .replace('hasDatabase, startHarness', 'hasDatabase as always, startHarness')
    .replace('describe.skipIf', 'const hasDatabase = false\ndescribe.skipIf')
  assert.match(errors(renamed).join('\n'), /added test modifier/)
  const elsewhere = file.replace("'../../testing/harness.ts'", "'./harness.ts'")
  assert.match(errors(elsewhere).join('\n'), /added test modifier/)
})

test('only a new file may add it, and only in the control plane', () => {
  const existing = file.replace('describe.skipIf(!hasDatabase)', 'describe')
  assert.match(errors(file, { before: existing }).join('\n'), /added test modifier/)
  assert.match(errors(file, { at: 'apps/web/src/claims.test.ts' }).join('\n'), /added test modifier/)
})

test("CI's evidence still refuses a case that skipped", () => {
  const junit = `<?xml version="1.0"?><testsuites><testsuite name="${path}" file="${path}" tests="1" failures="0" errors="0" skipped="1" time="0"><testcase name="says nothing" classname="" time="0"><skipped/></testcase></testsuite></testsuites>`
  assert.throws(() => checkJUnit(junit, [path]), /skipped/i)
})
