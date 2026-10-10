// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { OperationView } from '@blockly/contracts'
import { outcomeOf } from './outcome.ts'

const running = (id: string): OperationView => ({
  id,
  kind: 'apply',
  status: 'running',
  step: 'booting',
  error: null,
  createdAt: '2026-09-24T10:00:00Z',
  startedAt: '2026-09-24T10:00:00Z',
})
const change = (status: 'succeeded' | 'failed', at: string) => ({ status, error: null, at })

describe('how a press ended', () => {
  // Pressed at 10:00, answered with operation `a` at version 5.
  const awaited = { operationId: 'a', since: Date.parse('2026-09-24T10:00:00Z'), version: 5 }

  test('its work is still going while that operation runs, or the page shows the server from before', () => {
    expect(
      outcomeOf(awaited, { activeOperation: running('a'), status: 'updating', lastChange: null, version: 5 }),
    ).toBe('going')
    expect(
      outcomeOf(awaited, { activeOperation: null, status: 'running', lastChange: null, version: 4 }),
    ).toBe('going')
  })

  test('it is done once the server has finished it well', () => {
    const later = change('succeeded', '2026-09-24T10:00:40Z')
    expect(
      outcomeOf(awaited, { activeOperation: null, status: 'running', lastChange: later, version: 7 }),
    ).toBe('done')
    // Something else running now is not this press's work.
    expect(
      outcomeOf(awaited, { activeOperation: running('b'), status: 'running', lastChange: null, version: 8 }),
    ).toBe('done')
  })

  test('it failed when the server did, or a change that finished after the press did', () => {
    expect(
      outcomeOf(awaited, { activeOperation: null, status: 'failed', lastChange: null, version: 7 }),
    ).toBe('failed')
    const failed = change('failed', '2026-09-24T10:00:40Z')
    expect(
      outcomeOf(awaited, { activeOperation: null, status: 'running', lastChange: failed, version: 7 }),
    ).toBe('failed')
    // A change that failed before the press isn't this one.
    const earlier = change('failed', '2026-09-24T09:30:00Z')
    expect(
      outcomeOf(awaited, { activeOperation: null, status: 'running', lastChange: earlier, version: 7 }),
    ).toBe('done')
  })
})
