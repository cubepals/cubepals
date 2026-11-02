// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Stage estimates never imply that unknown work or a stalled byte count has a known end. */
import { describe, expect, test } from 'bun:test'
import type { WorldImportProgress } from '@blockly/contracts'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { readingElapsed, readingProgress } from './reading-pace.ts'

const at = (ms: number) => new Date(ms).toISOString()
const progress = (overrides: Partial<WorldImportProgress> = {}): WorldImportProgress => ({
  step: 'fetching',
  startedAt: at(0),
  updatedAt: at(10 * SECOND_MS),
  bytes: 100 * 1024 ** 2,
  totalBytes: 200 * 1024 ** 2,
  steps: [{ step: 'fetching', at: at(0) }],
  ...overrides,
})

describe('measured progress reading a world', () => {
  test('waits for the worker before claiming work has started', () => {
    expect(readingProgress(null, MINUTE_MS)).toMatchObject({ percent: null })
    expect(readingProgress(null, MINUTE_MS).detail).not.toContain('left')
  })

  test('estimates only a measured stage and shows its byte counts', () => {
    const view = readingProgress(progress(), 10 * SECOND_MS)
    expect(view.percent).toBe(50)
    expect(view.detail).toBe('100 MB of 200 MB · 10s elapsed · About 10 seconds left in this step')
  })

  test('does not count down across unknown work, or from stale or insufficient measurements', () => {
    for (const state of [
      progress({ totalBytes: null, step: 'mods' }),
      progress({ bytes: 0 }),
      progress({ updatedAt: at(SECOND_MS) }),
    ]) {
      expect(readingProgress(state, MINUTE_MS).detail).not.toContain('left')
    }
    expect(readingProgress(progress({ totalBytes: null }), MINUTE_MS).percent).toBeNull()
  })

  test('starts a stage estimate at that stage, while elapsed time covers the whole attempt', () => {
    const view = readingProgress(
      progress({
        updatedAt: at(70 * SECOND_MS),
        steps: [
          { step: 'fetching', at: at(0) },
          { step: 'packing', at: at(MINUTE_MS) },
        ],
        step: 'packing',
      }),
      70 * SECOND_MS,
    )
    expect(view.detail).toContain('1m 10s elapsed')
    expect(view.detail).toContain('About 10 seconds left in this step')
  })

  test('a full byte count waits for the next stage to acknowledge completion', () => {
    const view = readingProgress(progress({ bytes: 200 * 1024 ** 2 }), 10 * SECOND_MS)
    expect(view.percent).toBe(99)
    expect(view.detail).not.toContain('left')
    expect(readingElapsed(-1)).toBe('0s')
  })
})
