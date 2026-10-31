// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { OperationView } from '@blockly/contracts'
import { busyFor, powerBusy } from './button-busy.ts'
import { busyWord } from './present.ts'

const running = (id: string, kind: OperationView['kind']): OperationView => ({
  id,
  kind,
  change: kind === 'apply' ? 'world' : null,
  worldBytes: null,
  broughtWorld: null,
  status: 'running',
  step: 'storage',
  error: null,
  createdAt: '2026-10-31T00:58:08Z',
  startedAt: '2026-10-31T00:58:08Z',
})

describe('which button wears the server’s work', () => {
  const fresh = running('fresh', 'apply')
  const restore = running('restore', 'restore')

  test('the button whose press started it, in the server’s words', () => {
    expect(busyFor({ awaiting: 'fresh' }, { activeOperation: fresh })).toBe(busyWord(fresh))
  })

  test('no other: a restore begun elsewhere leaves a fresh world’s button in its own words', () => {
    expect(busyFor({ awaiting: null }, { activeOperation: restore })).toBeUndefined()
    expect(busyFor({ awaiting: 'fresh' }, { activeOperation: restore })).toBeUndefined()
    expect(busyFor({ awaiting: 'fresh' }, { activeOperation: null })).toBeUndefined()
  })

  test('the power button wears waking and sleeping, however they began, and nothing else', () => {
    for (const kind of ['start', 'stop', 'store', 'unstore'] as const)
      expect(powerBusy(running('op', kind))).toBe(busyWord(running('op', kind)))
    for (const kind of ['restore', 'apply', 'relocate', 'backup', 'restart'] as const)
      expect(powerBusy(running('op', kind))).toBeUndefined()
    expect(powerBusy(null)).toBeUndefined()
  })
})
