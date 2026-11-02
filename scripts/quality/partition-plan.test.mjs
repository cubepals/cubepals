// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Scheduling remains exhaustive under skewed costs, new files and weekly audit rotations. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { rotationSubjects } from './mutation-scope.mjs'
import { balance, mutationAssignment, mutationPartitions, nativePartitions } from './partition-plan.mjs'
import { groups } from './shards.mjs'

test('longest-first scheduling balances measured work and never drops a new path', () => {
  const input = ['slow', 'medium', 'short', 'new']
  const costs = { slow: 10, medium: 6, short: 4 }
  const parts = balance(input, costs, 2)
  assert.deepEqual(parts, [
    ['new', 'slow'],
    ['medium', 'short'],
  ])
  assert.deepEqual(parts.flat().sort(), input.sort())
  assert.deepEqual(balance([...input].reverse(), costs, 2), parts)
})

test('empty work still declares every expected runner', () => {
  assert.deepEqual(balance([], {}, 4), [[], [], [], []])
})

test('invalid and duplicated scheduler inputs fail closed', () => {
  for (const count of [0, -1, 17, 1.5, NaN]) assert.throws(() => balance(['a'], {}, count), /partition count/)
  for (const paths of [['a', 'a'], [''], [null]]) assert.throws(() => balance(paths, {}, 2), /unique paths/)
  for (const value of [0, -1, Infinity, '10', null])
    assert.throws(() => balance(['a'], { a: value }, 2), /cost/)
})

test('native partition counts still cover all seven logical groups', () => {
  assert.deepEqual(Object.keys(nativePartitions).sort(), Object.keys(groups).sort())
  assert.equal(
    Object.values(nativePartitions).reduce((a, b) => a + b),
    17,
  )
})

test('all mutation files belong to exactly one runner, irrespective of their cost', () => {
  const subjects = Array.from({ length: 103 }, (_, i) => `apps/source-${i}.ts`)
  const parts = Array.from({ length: mutationPartitions }, (_, i) =>
    mutationAssignment(subjects, { [subjects[0]]: 500 }, i),
  )
  assert.equal(new Set(parts.flat()).size, subjects.length)
  assert.deepEqual(parts.flat().sort(), [...subjects].sort())
  for (const index of [-1, 4, 1.5]) assert.throws(() => mutationAssignment(subjects, {}, index), /partition/)
})

test('four runners preserve the exact seven original daily rotations', () => {
  const subjects = Array.from(
    { length: 301 },
    (_, i) => `${i % 2 ? 'apps/web' : 'packages/contracts'}/source-${i}.ts`,
  )
  const visited = []
  for (let day = 0; day < 7; day++) {
    const selected = Array.from({ length: 4 }, (_, i) => mutationAssignment(subjects, {}, i, day)).flat()
    assert.deepEqual(selected.sort(), rotationSubjects(subjects, day).sort())
    visited.push(...selected)
  }
  assert.equal(new Set(visited).size, subjects.length)
  assert.deepEqual(visited.sort(), subjects.sort())
})
