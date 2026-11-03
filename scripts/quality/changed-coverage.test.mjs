// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Legacy debt cannot mask an untested edit, and an edit does not acquire unrelated legacy obligations. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changedCounters } from './changed-coverage.mjs'
import { fileMetrics } from './coverage.mjs'

const loc = (start, end = start) => ({ start: { line: start, column: 0 }, end: { line: end, column: 10 } })
const file = {
  statementMap: { 0: loc(1, 30), 1: loc(4), 2: loc(7), 3: loc(28) },
  s: { 0: 1, 1: 1, 2: 0, 3: 0 },
  fnMap: { 0: { loc: loc(3, 10), decl: loc(3) }, 1: { loc: loc(27, 30), decl: loc(27) } },
  f: { 0: 1, 1: 0 },
  branchMap: { 0: { loc: loc(5, 9), locations: [loc(6, 7), loc(8, 9)] } },
  b: { 0: [0, 1] },
}
test('covered changed behavior passes without requiring the unrelated dead function', () => {
  const selected = changedCounters(file, [{ start: 4, end: 4 }])
  assert.equal(fileMetrics(file).functions.percent, 50)
  assert.equal(fileMetrics(selected).functions.percent, 100)
  assert.deepEqual(Object.keys(selected.s), ['1'])
})
test('untested changed statements and branch arms retain zero credit', () => {
  const selected = changedCounters(file, [{ start: 7, end: 7 }])
  assert.equal(fileMetrics(selected).lines.percent, 0)
  assert.equal(fileMetrics(selected).branches.percent, 0)
})
test('changing a decision requires every outcome, including the missing path', () => {
  assert.equal(fileMetrics(changedCounters(file, [{ start: 5, end: 5 }])).branches.percent, 50)
})
test('new source retains its complete maps and coverage floors', () => {
  assert.equal(changedCounters(file, null), file)
})
test('nonexecutable edits have no invented executable obligations', () => {
  assert.equal(fileMetrics(changedCounters(file, [])).lines.total, 0)
})
