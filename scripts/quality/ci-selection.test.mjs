// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Pure scheduling contracts: no omitted cross-runtime consumers or ambiguous dependency passes. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyChanges } from './check-plan.mjs'
import { affectedSelection } from './ci-selection.mjs'

const web = 'apps/web/src/card.tsx',
  webTest = 'apps/web/src/card.test.tsx'
const billing = 'apps/control/src/app/billing/service.ts',
  billingTest = 'apps/control/src/app/billing/service.test.ts'
const shared = 'packages/contracts/src/billing.ts'
const view = (rows, ambiguous = []) => ({
  graph: new Map(rows.map(([path, deps]) => [path, new Set(deps)])),
  tests: [webTest, billingTest],
  ambiguous: new Set(ambiguous),
})
const simple = view([
  [webTest, [web]],
  [billingTest, [billing]],
  [web, []],
  [billing, []],
])

test('website feedback omits unrelated backend and provider work', () => {
  const checks = classifyChanges([web])
  assert.equal(checks.worker, true)
  assert.equal(checks.images, false)
  assert.equal(checks.fleet, false)
  assert.deepEqual(affectedSelection([simple, simple], [web], checks).tests, [[webTest], [webTest]])
})
test('billing retains its integration oracles without building unchanged website and runtime images', () => {
  const checks = classifyChanges([billing])
  assert.equal(checks.images, true)
  assert.equal(checks.fleet, false)
  assert.equal(checks.worker, false)
  assert.deepEqual(affectedSelection([simple, simple], [billing], checks).tests, [
    [billingTest],
    [billingTest],
  ])
})
test('shared contracts keep both sides of the interface', () => {
  const graph = view([
    [webTest, [web]],
    [billingTest, [billing]],
    [web, [shared]],
    [billing, [shared]],
    [shared, []],
  ])
  assert.deepEqual(affectedSelection([graph, graph], [shared]).tests, [
    [webTest, billingTest].sort(),
    [webTest, billingTest].sort(),
  ])
})
test('deleting a dependency cannot hide its original regression suite', () => {
  const after = view([
    [webTest, []],
    [billingTest, [billing]],
    [web, []],
    [billing, []],
  ])
  assert.deepEqual(affectedSelection([simple, after], [web], { website: true }).tests, [[webTest], [webTest]])
})
test('uncertainty widens the website runtime and preserves proven external consumers', () => {
  const graph = view(
    [
      [webTest, [web]],
      [billingTest, [web]],
      [web, []],
    ],
    [web],
  )
  const selection = affectedSelection([graph, graph], [web], { website: true })
  assert.equal(selection.fallback, true)
  assert.deepEqual(selection.tests, [[webTest, billingTest].sort(), [webTest, billingTest].sort()])
})
test('unknown infrastructure or execution inputs cannot select a cheaper check profile', () => {
  for (const path of ['bun.lock', 'unmapped/input.conf', '.github/workflows/ci.yml']) {
    const checks = classifyChanges([path])
    assert.equal(checks.broad, true)
    assert.equal(checks.fleet, true)
    assert.equal(checks.images, true)
  }
  assert.equal(classifyChanges(['infra/terraform/main.tf']).fleet, true)
})
test('explicit complete audits preserve every test', () => {
  assert.deepEqual(affectedSelection([simple, simple], [web], { full: true }).tests, [
    [webTest, billingTest].sort(),
    [webTest, billingTest].sort(),
  ])
})
