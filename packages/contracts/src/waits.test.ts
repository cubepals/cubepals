// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** How a test waits (`waits.ts`): for the thing, failing with what it waited for and saw. */
import { expect, test } from 'bun:test'
import { stays, until } from './waits.ts'

test('until returns as soon as its check holds, async checks included', async () => {
  let n = 0
  await until('three looks', () => ++n >= 3)
  expect(n).toBe(3)
  await until('an async yes', async () => true)
})

test('until fails past its deadline, naming what it waited for and what was seen', async () => {
  await expect(
    until('a door to open', () => false, { timeoutMs: 120, seen: () => 'door: shut' }),
  ).rejects.toThrow('Timed out waiting for a door to open\ndoor: shut')
})

test('stays holds for its time, and fails as soon as its check stops holding', async () => {
  const started = Date.now()
  await stays('the door shut', () => true, 120)
  expect(Date.now() - started).toBeGreaterThanOrEqual(120)
  // It stops holding at the first look: the failure comes at once, not after 5 s.
  const before = Date.now()
  await expect(stays('the door shut', () => false, 5_000, { seen: () => 'door: open' })).rejects.toThrow(
    'Expected the door shut to hold for 5000 ms\ndoor: open',
  )
  expect(Date.now() - before).toBeLessThan(1_000)
})
