// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Case ordering preserves every survivor's oracle and rejects incomplete or misleading evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { proveCaseOrder, runCaseOrder } from './mutation-case-order.mjs'
import { readMutationJUnit } from './mutation-evidence.mjs'

const file = 'apps/example.test.ts'
const names = ['slow', 'quick', 'middle', 'other', 'last', 'sixth']
const xml = (states = {}) =>
  `<testsuites><testsuite file="${file}">${names
    .map(
      (name, index) =>
        `<testcase name="${name}" classname="suite" time="${index + 1}">${
          states[name] === 'filtered' ? '<skipped/>' : states[name] === 'failed' ? '<failure/>' : ''
        }</testcase>`,
    )
    .join('')}</testsuite></testsuites>`

function fixture() {
  const cases = []
  readMutationJUnit(xml(), [file], { caseResults: cases })
  const execute = (batch) => {
    const pattern = new RegExp(batch.pattern)
    return {
      xml: xml(
        Object.fromEntries(names.filter((name) => !pattern.test(name)).map((name) => [name, 'filtered'])),
      ),
      exitCode: 0,
      durationMs: 1,
      report: 'actual-batch.xml',
    }
  }
  return { cases, execute, plan: proveCaseOrder(cases, [file], 10_000, execute) }
}

test('a survivor executes every original case and preserves raw report references', () => {
  const { plan, execute } = fixture()
  assert.ok(plan)
  const result = runCaseOrder(plan, [file], execute)
  assert.equal(result.passed, names.length)
  assert.equal(result.failed, 0)
  assert.equal(result.reports.length, plan.batches.length)
})

test('case ordering is not used when a clean split needs other cases to pass', () => {
  const { cases } = fixture()
  const plan = proveCaseOrder(cases, [file], 10_000, () => ({
    xml: xml({ quick: 'failed' }),
    exitCode: 1,
    durationMs: 1,
  }))
  assert.equal(plan, null)
})

test('a genuine assertion failure can stop after the first proven batch', () => {
  const { plan, execute } = fixture()
  let calls = 0
  const result = runCaseOrder(plan, [file], (batch) => {
    calls++
    const result = execute(batch)
    const name = JSON.parse(batch.cases[0])[2]
    const pattern = new RegExp(batch.pattern)
    const states = Object.fromEntries(
      names.map((item) => [item, item === name ? 'failed' : pattern.test(item) ? 'passed' : 'filtered']),
    )
    return { ...result, exitCode: 1, xml: xml(states) }
  })
  assert.equal(result.failed, 1)
  assert.equal(calls, 1)
})

test('omitting a case from the plan is rejected before any mutant runs', () => {
  const { plan, execute } = fixture()
  plan.batches.pop()
  assert.throws(() => runCaseOrder(plan, [file], execute), /omits original cases/)
})

test('a filtered-out selected case never becomes a successful survivor', () => {
  const { plan, execute } = fixture()
  assert.throws(
    () =>
      runCaseOrder(plan, [file], (batch) => {
        const result = execute(batch)
        return { ...result, xml: result.xml.replace(/><\/testcase>/g, '><skipped/></testcase>') }
      }),
    /skipped mutation test|No mutation tests executed/,
  )
})

test('missing selected cases and failures outside the proven selection are rejected', () => {
  const { plan, execute } = fixture()
  const combined = structuredClone(plan)
  combined.batches[0].cases.push(combined.batches[1].cases[0])
  assert.throws(() => runCaseOrder(combined, [file], execute), /skipped mutation test|every selected case/)
  assert.throws(
    () =>
      runCaseOrder(plan, [file], (batch) => {
        const result = execute(batch)
        const outside = names.find((name) => !batch.cases.some((id) => JSON.parse(id)[2] === name))
        const states = Object.fromEntries(
          names.map((name) => [
            name,
            name === outside ? 'failed' : new RegExp(batch.pattern).test(name) ? 'passed' : 'filtered',
          ]),
        )
        return { ...result, exitCode: 1, xml: xml(states) }
      }),
    /outside its proven selection/,
  )
})

test('an invented assertion failure, unknown case, or inconsistent process exit is rejected', () => {
  const { plan, execute } = fixture()
  assert.throws(
    () => runCaseOrder(plan, [file], (batch) => ({ ...execute(batch), exitCode: 1 })),
    /exit status/,
  )
  assert.throws(
    () =>
      runCaseOrder(plan, [file], (batch) => ({
        ...execute(batch),
        xml: execute(batch).xml.replace('name="slow"', 'name="invented"'),
      })),
    /Unexpected|skipped/,
  )
})

test('missing, duplicate, or unmeasured case identities keep the original invocation', () => {
  const { cases, execute } = fixture()
  assert.equal(proveCaseOrder([...cases, cases[0]], [file], 10_000, execute), null)
  assert.equal(
    proveCaseOrder(
      cases.map((item) => ({ ...item, durationMs: NaN })),
      [file],
      10_000,
      execute,
    ),
    null,
  )
  assert.equal(
    proveCaseOrder(cases, [file], 10_000, () => {
      throw new Error('missing XML')
    }),
    null,
  )
  assert.equal(proveCaseOrder(cases, [file], 1, execute), null)
})
