// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { type Ran, TERRAFORM_WAITS_MS, untilItRuns } from './terraform-retries.ts'

/** A command that ends as `ends` says, one run each, and what waiting and saying saw. */
function runs(...ends: Ran[]) {
  const waited: number[] = []
  const said: string[] = []
  let ran = 0
  const done = untilItRuns(() => ends[ran++] ?? { status: 0 }, {
    wait: (ms) => waited.push(ms),
    say: (line) => said.push(line),
  })
  return { done, ran, waited, said }
}

test('the waits outlast an outage of Fly’s API of several minutes, growing as they go', () => {
  const total = TERRAFORM_WAITS_MS.reduce((sum, ms) => sum + ms, 0)
  expect(total).toBeGreaterThan(5 * MINUTE_MS)
  expect([...TERRAFORM_WAITS_MS]).toEqual([...TERRAFORM_WAITS_MS].sort((a, b) => a - b))
})

test('a run that works is run once', () => {
  expect(runs({ status: 0 })).toMatchObject({ done: { status: 0 }, ran: 1, waited: [] })
})

test('a stop is tried again after each wait, and the try that works ends it', () => {
  const stopped = { status: 1 }
  const { done, ran, waited, said } = runs(stopped, stopped, stopped, { status: 0 })
  expect(done.status).toBe(0)
  expect(ran).toBe(4)
  expect(waited).toEqual(TERRAFORM_WAITS_MS.slice(0, 3))
  expect(said[2]).toBe(`stopped (exit 1); trying again in ${TERRAFORM_WAITS_MS[2] / 1000} s.`)
})

test('once every wait is spent, the last stop is what comes back', () => {
  const stops = Array.from({ length: TERRAFORM_WAITS_MS.length + 1 }, (_, i) => ({ status: i + 1 }))
  const { done, ran, waited } = runs(...stops)
  expect(ran).toBe(TERRAFORM_WAITS_MS.length + 1)
  expect(waited).toEqual([...TERRAFORM_WAITS_MS])
  expect(done.status).toBe(TERRAFORM_WAITS_MS.length + 1)
})

test('a run stopped by a signal, as a cancelled deploy is, is never run again', () => {
  const { done, ran, waited } = runs({ status: 1 }, { status: null, signal: 'SIGTERM' })
  expect(done).toEqual({ status: null, signal: 'SIGTERM' })
  expect(ran).toBe(2)
  expect(waited).toHaveLength(1)
})
