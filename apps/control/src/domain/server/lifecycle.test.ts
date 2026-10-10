// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import {
  type Command,
  decide,
  InvalidTransition,
  type Lifecycle,
  ROUTABLE,
  type ServerStatus,
  transition,
} from './lifecycle.ts'

const at = (status: ServerStatus, extra: Partial<Lifecycle> = {}): Lifecycle => ({
  status,
  stopReason: null,
  failure: null,
  ...extra,
})

describe('decide', () => {
  test('start moves a stopped server to starting and queues a start', () => {
    expect(decide(at('stopped', { stopReason: 'idle' }), { type: 'start' })).toEqual({
      kind: 'accept',
      to: at('starting'),
      operation: 'start',
    })
  })

  test('start and stop are idempotent where they already hold', () => {
    expect(decide(at('running'), { type: 'start' })).toEqual({ kind: 'noop' })
    expect(decide(at('starting'), { type: 'start' })).toEqual({ kind: 'noop' })
    expect(decide(at('stopped'), { type: 'stop', reason: 'user' })).toEqual({ kind: 'noop' })
    expect(decide(at('stopping'), { type: 'stop', reason: 'idle' })).toEqual({ kind: 'noop' })
  })

  test('stop is taken from running; restart goes through stopping, then starting (§10)', () => {
    expect(decide(at('running'), { type: 'stop', reason: 'user' })).toEqual({
      kind: 'accept',
      to: at('stopping'),
      operation: 'stop',
    })
    expect(decide(at('starting'), { type: 'stop', reason: 'user' })).toEqual({ kind: 'invalid' })
    expect(decide(at('running'), { type: 'restart' })).toEqual({
      kind: 'accept',
      to: at('stopping'),
      operation: 'restart',
    })
    expect(transition(at('stopping'), { type: 'restarting' })).toEqual(at('starting'))
    expect(() => transition(at('running'), { type: 'restarting' })).toThrow(InvalidTransition)
    // Failing in its stop half, a restart fails as the start it was on its way to.
    const failure = { during: 'starting' as const, message: 'no answer', operationId: 'op-1' }
    expect(transition(at('stopping'), { type: 'failed', failure })).toEqual(at('failed', { failure }))
  })

  test('a restore or move that policy kept from booting ends stopped, and says why', () => {
    expect(transition(at('restoring'), { type: 'restored', running: false, reason: 'policy' })).toEqual(
      at('stopped', { stopReason: 'policy' }),
    )
    expect(transition(at('relocating'), { type: 'relocated', running: false })).toEqual(
      at('stopped', { stopReason: 'user' }),
    )
  })

  test('a provisioning server can only be deleted', () => {
    const commands: Command[] = [
      { type: 'start' },
      { type: 'stop', reason: 'user' },
      { type: 'restart' },
      { type: 'apply' },
      { type: 'relocate' },
    ]
    for (const command of commands) expect(decide(at('provisioning'), command)).toEqual({ kind: 'invalid' })
    expect(decide(at('provisioning'), { type: 'delete' })).toMatchObject({
      kind: 'accept',
      operation: 'decommission',
    })
  })

  test('a failed server can be moved, and comes out of the move with its failure left behind', () => {
    const failed = at('failed', { failure: { during: 'starting', message: 'boom', operationId: 'op' } })
    expect(decide(failed, { type: 'relocate' })).toEqual({
      kind: 'accept',
      to: at('relocating'),
      operation: 'relocate',
    })
  })

  test('applying to a stopped server changes nothing but is accepted', () => {
    const stopped = at('stopped', { stopReason: 'user' })
    expect(decide(stopped, { type: 'apply' })).toEqual({ kind: 'accept', to: stopped, operation: null })
  })

  test('retry resumes the phase that failed', () => {
    const failed = at('failed', { failure: { during: 'updating', message: 'boom', operationId: 'op' } })
    expect(decide(failed, { type: 'retry' })).toEqual({
      kind: 'accept',
      to: at('updating'),
      operation: 'apply',
    })
    expect(decide(at('running'), { type: 'retry' })).toEqual({ kind: 'invalid' })
  })

  test('rollback applies to a running server, waits on a stopped one, and boots a failed one', () => {
    expect(decide(at('running'), { type: 'rollback' })).toEqual({
      kind: 'accept',
      to: at('updating'),
      operation: 'apply',
    })
    const stopped = at('stopped', { stopReason: 'user' })
    expect(decide(stopped, { type: 'rollback' })).toEqual({ kind: 'accept', to: stopped, operation: null })
    const failed = at('failed', { failure: { during: 'updating', message: 'boom', operationId: 'op' } })
    expect(decide(failed, { type: 'rollback' })).toEqual({
      kind: 'accept',
      to: at('starting'),
      operation: 'start',
    })
    expect(decide(at('updating'), { type: 'rollback' })).toEqual({ kind: 'invalid' })
  })

  test('deleted servers can be undeleted but not started', () => {
    expect(decide(at('deleted'), { type: 'start' })).toEqual({ kind: 'invalid' })
    expect(decide(at('deleted'), { type: 'undelete', stored: false })).toMatchObject({
      kind: 'accept',
      to: { status: 'stopped' },
    })
    expect(decide(at('purged'), { type: 'delete' })).toEqual({ kind: 'noop' })
  })
})

describe('transition', () => {
  test('outcomes settle the status a command moved to', () => {
    expect(transition(at('provisioning'), { type: 'provisioned' })).toEqual(at('running'))
    expect(transition(at('stopping'), { type: 'stopped', reason: 'idle' })).toEqual(
      at('stopped', { stopReason: 'idle' }),
    )
    expect(transition(at('restoring'), { type: 'restored', running: false })).toEqual(
      at('stopped', { stopReason: 'user' }),
    )
  })

  test('a failure records the phase so retry can resume it', () => {
    const failure = { during: 'starting' as const, message: 'no answer', operationId: 'op-1' }
    expect(transition(at('starting'), { type: 'failed', failure })).toEqual(at('failed', { failure }))
  })

  test('an outcome that does not fit the current status throws', () => {
    expect(() => transition(at('stopped'), { type: 'started' })).toThrow(InvalidTransition)
    expect(() => transition(at('starting'), { type: 'crashed' })).toThrow(InvalidTransition)
    expect(() =>
      transition(at('running'), {
        type: 'failed',
        failure: { during: 'updating', message: '', operationId: '' },
      }),
    ).toThrow(InvalidTransition)
  })
})

describe('resting worlds', () => {
  test('starting a resting world brings it back through a restore nothing routes to', () => {
    for (const type of ['start', 'restart'] as const)
      expect(decide(at('stored'), { type })).toEqual({
        kind: 'accept',
        to: at('restoring'),
        operation: 'unstore',
      })
    // A second join while it comes back waits for the same wake.
    expect(decide(at('restoring'), { type: 'start' })).toEqual({ kind: 'noop' })
    // It is reachable at its address, which is what wakes it; while it lets go, it is not.
    expect(ROUTABLE).toContain('stored')
    expect(ROUTABLE).not.toContain('storing')
  })

  test('nothing that needs its disk runs while it rests; stopping is already done', () => {
    for (const status of ['stored', 'storing'] as const) {
      for (const command of [
        { type: 'apply' },
        { type: 'rollback' },
        { type: 'restore' },
        { type: 'relocate' },
      ] as Command[])
        expect(decide(at(status), command)).toEqual({ kind: 'invalid' })
      expect(decide(at(status), { type: 'stop', reason: 'user' })).toEqual({ kind: 'noop' })
      expect(decide(at(status), { type: 'delete' })).toMatchObject({
        kind: 'accept',
        operation: 'decommission',
      })
    }
    expect(decide(at('storing'), { type: 'start' })).toEqual({ kind: 'invalid' })
  })

  test('a deleted world comes back from the trash resting if it was resting, never stopped on nothing', () => {
    expect(decide(at('deleted'), { type: 'undelete', stored: true })).toEqual({
      kind: 'accept',
      to: at('stored'),
      operation: null,
    })
    expect(decide(at('deleted'), { type: 'undelete', stored: false })).toMatchObject({
      to: { status: 'stopped' },
    })
  })

  test('resting goes stopped → storing → stored; a wake that fails goes back to stored', () => {
    expect(transition(at('stopped', { stopReason: 'idle' }), { type: 'storing' })).toEqual(at('storing'))
    expect(transition(at('storing'), { type: 'stored' })).toEqual(at('stored'))
    expect(transition(at('restoring'), { type: 'stored' })).toEqual(at('stored'))
    expect(() => transition(at('running'), { type: 'storing' })).toThrow(InvalidTransition)
    expect(() => transition(at('stopped'), { type: 'stored' })).toThrow(InvalidTransition)
  })
})
