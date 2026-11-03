// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real Git snapshots and the real module resolver prove scope and reject stale working inputs. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ciImpact } from './ci-impact.mjs'
import { testPlan } from './partition-plan.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-risk-proof-'))
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  put('package.json', '{"type":"module"}')
  put('scripts/quality/runtime-costs.json', '{"tests":{},"mutations":{}}')
  put('apps/web/src/card.ts', 'export const label = "old"\n')
  put(
    'apps/web/src/card.test.ts',
    'import {test,expect} from "bun:test"; import {label} from "./card"; test("label",()=>expect(label).toBe("old"))\n',
  )
  put('apps/control/src/app/billing/service.ts', 'export const paid = true\n')
  put(
    'apps/control/src/app/billing/service.test.ts',
    'import {test,expect} from "bun:test"; import {paid} from "./service"; test("paid",()=>expect(paid).toBe(true))\n',
  )
  git('init', '-q', '--template=', '-b', 'main')
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
  const base = commit()
  return { root, put, git, commit, base }
}

test('a website edit selects its actual test, one runner, and no backend services', () => {
  const f = fixture()
  try {
    f.put('apps/web/src/card.ts', 'export const label = "new"\n')
    const head = f.commit()
    const result = ciImpact(f.root, f.base, head, 'affected')
    assert.deepEqual(result.tests, [['apps/web/src/card.test.ts'], ['apps/web/src/card.test.ts']])
    assert.equal(result.services, false)
    const plan = testPlan(f.root, f.base, head, 'affected')
    assert.equal(
      Object.values(plan.groups)
        .flatMap((group) => group.partitions)
        .filter((paths) => paths.length).length,
      1,
    )
    assert.equal(plan.impact.checks.fleet, false)
    assert.equal(plan.impact.checks.worker, true)
    f.put('apps/web/src/card.ts', 'export const label = "uncommitted"\n')
    assert.throws(() => ciImpact(f.root, f.base, head, 'affected'), /differs from the tested commit/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
test('billing retains real integration tests and database prerequisites', () => {
  const f = fixture()
  try {
    f.put('apps/control/src/app/billing/service.ts', 'export const paid = false\n')
    const head = f.commit()
    const result = ciImpact(f.root, f.base, head, 'affected')
    assert.deepEqual(result.tests, [
      ['apps/control/src/app/billing/service.test.ts'],
      ['apps/control/src/app/billing/service.test.ts'],
    ])
    assert.equal(result.services, true)
    assert.equal(result.checks.images, true)
    f.put('apps/web/src/hidden.test.ts', 'throw new Error("untracked oracle")')
    assert.throws(() => ciImpact(f.root, f.base, head, 'affected'), /committed input inventory/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
