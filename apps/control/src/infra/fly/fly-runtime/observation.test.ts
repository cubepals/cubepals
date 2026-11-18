// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { observationOf } from './observation.ts'

const exited = (at: number, exitEvent: Record<string, unknown>) => ({
  state: 'stopped',
  events: [{ type: 'exit', timestamp: at, request: { exit_event: exitEvent } }],
})

test('a stop that was asked for, in which the kernel killed Java for want of memory, says so and is no crash', () => {
  // As Fly recorded a 3 GB server's Java killed writing its startup recording as it stopped.
  const at = Date.now() - 30_000
  const killed = exited(at, {
    exit_code: 255,
    guest_signal: -1,
    oom_killed: true,
    requested_stop: true,
    signal: -1,
    exited_at: new Date(at).toISOString(),
  })
  const seen = observationOf(killed as never)
  expect(seen.state).toBe('stopped')
  expect(seen.exit).toBeUndefined()
  expect(seen.killedForMemoryAt).toEqual(new Date(at))
})

test('a crash for want of memory says when, beside its exit; a stop that went as asked says nothing of it', () => {
  const at = Date.now() - 90_000
  const crashed = observationOf(
    exited(at, { exit_code: 137, oom_killed: true, requested_stop: false }) as never,
  )
  expect(crashed).toMatchObject({
    state: 'crashed',
    exit: { code: 137, oom: true },
    killedForMemoryAt: new Date(at),
  })
  const clean = observationOf(exited(at, { exit_code: 0, requested_stop: true }) as never)
  expect(clean.killedForMemoryAt).toBeUndefined()
  const restarted = observationOf({
    state: 'started',
    events: [{ type: 'exit', timestamp: at, request: { exit_event: { exit_code: 137, oom_killed: true } } }],
  } as never)
  expect(restarted).toMatchObject({
    state: 'running',
    failedAt: new Date(at),
    killedForMemoryAt: new Date(at),
  })
})
