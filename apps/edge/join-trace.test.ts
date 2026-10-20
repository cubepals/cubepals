// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A held join's line in the edge's log, on a clock the test turns. */
import { expect, test } from 'bun:test'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { JoinTrace } from './join-trace.ts'

const clock = () => {
  let ms = Date.parse('2026-10-20T15:43:21.000Z')
  return {
    now: () => new Date(ms),
    pass: (by: number) => {
      ms += by
    },
  }
}

test('a join let in says when each step came, how it ended and what passed each way', () => {
  const { now, pass } = clock()
  const trace = new JoinTrace('arcade.play.test', now)
  trace.named('Steve')
  trace.mark('wakeAsked')
  pass(3 * SECOND_MS)
  trace.mark('up')
  trace.mark('forwarded')
  trace.ended('let in')
  pass(60 * SECOND_MS)
  expect(trace.record({ fromPlayer: 10, toPlayer: 20 })).toEqual({
    hostname: 'arcade.play.test',
    name: 'Steve',
    at: {
      connected: '2026-10-20T15:43:21.000Z',
      wakeAsked: '2026-10-20T15:43:21.000Z',
      up: '2026-10-20T15:43:24.000Z',
      forwarded: '2026-10-20T15:43:24.000Z',
      left: '2026-10-20T15:44:24.000Z',
    },
    outcome: 'let in',
    bytes: { fromPlayer: 10, toPlayer: 20 },
  })
})

test('a join that leaves while held leaves out the steps it never reached, and a step keeps its first time', () => {
  const { now, pass } = clock()
  const trace = new JoinTrace('arcade.play.test', now)
  pass(SECOND_MS)
  trace.mark('wakeAsked')
  pass(SECOND_MS)
  trace.mark('wakeAsked')
  const line = trace.record({ fromPlayer: 0, toPlayer: 0 })
  expect(line.name).toBeNull()
  expect(line.outcome).toBe('left while held')
  expect(line.at).toEqual({
    connected: '2026-10-20T15:43:21.000Z',
    wakeAsked: '2026-10-20T15:43:22.000Z',
    left: '2026-10-20T15:43:23.000Z',
  })
})
