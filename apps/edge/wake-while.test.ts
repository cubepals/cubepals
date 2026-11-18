// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** How a held join keeps asking for its wake, on a clock of the test's own: no test waits on time. */
import { expect, test } from 'bun:test'
import type { WakeResult } from '@blockly/contracts/edge'
import { RETRY_MS, wakeWhile } from './wake-while.ts'

/** The control plane's window for one ask (`wakeWaitMs`). */
const WINDOW_MS = 25_000

/**
 * A wake asked of a stand-in control plane: each answer takes the time it is given, on a clock that
 * moves only when an answer or a pause says so. Records when each ask began and each pause.
 */
function control(answers: { after: number; result: WakeResult | Error }[], gone = () => false) {
  let clock = 0
  const asked: number[] = []
  const paused: number[] = []
  const asking = {
    ask: async () => {
      asked.push(clock)
      const next = answers.shift()
      if (next === undefined) throw new Error('asked once too often')
      clock += next.after
      if (next.result instanceof Error) throw next.result
      return next.result
    },
    gone,
    now: () => clock,
    sleep: async (ms: number) => {
      paused.push(ms)
      clock += ms
    },
  }
  return { asking, asked, paused }
}

const starting: WakeResult = { outcome: 'starting' }
const ready: WakeResult = { outcome: 'ready', destination: '10.0.0.1:25565' }

test('an ask that waited its whole window is asked again at once, with no pause', async () => {
  const { asking, asked, paused } = control([
    { after: WINDOW_MS, result: starting },
    { after: 1_000, result: ready },
  ])
  expect(await wakeWhile(asking, 120_000)).toEqual(ready)
  expect(asked).toEqual([0, WINDOW_MS])
  expect(paused).toEqual([])
})

test('an early answer or a failed ask waits out the rest of the two seconds from when it began', async () => {
  const { asking, asked, paused } = control([
    { after: 300, result: starting },
    { after: 0, result: new Error('wake answered 502') },
    { after: 500, result: ready },
  ])
  expect(await wakeWhile(asking, 120_000)).toEqual(ready)
  expect(paused).toEqual([RETRY_MS - 300, RETRY_MS])
  expect(asked).toEqual([0, RETRY_MS, 2 * RETRY_MS])
})

test('it stops at a refusal, a server left asleep, a client gone, or the deadline', async () => {
  const denied: WakeResult = { outcome: 'denied', reason: 'quota' }
  expect(await wakeWhile(control([{ after: 10, result: denied }]).asking, 120_000)).toEqual(denied)
  expect(await wakeWhile(control([{ after: 10, result: { outcome: 'asleep' } }]).asking, 120_000)).toEqual({
    outcome: 'asleep',
  })
  expect(await wakeWhile(control([{ after: 10, result: starting }], () => true).asking, 120_000)).toEqual(
    starting,
  )
  const late = control([
    { after: WINDOW_MS, result: starting },
    { after: WINDOW_MS, result: starting },
  ])
  expect(await wakeWhile(late.asking, 2 * WINDOW_MS)).toEqual(starting)
  expect(late.asked).toEqual([0, WINDOW_MS])
})
