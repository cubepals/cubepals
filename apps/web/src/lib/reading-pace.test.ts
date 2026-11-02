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
  test('a zero-sized step has no percentage and absent stage history uses the start time', () => {
    expect(readingProgress(progress({ totalBytes: 0 }), SECOND_MS).percent).toBeNull()
    expect(readingProgress(progress({ steps: [] }), 10 * SECOND_MS).detail).toContain('About 10 seconds left')
  })
})

test('names every stage and keeps elapsed time accurate at minute boundaries', () => {
  const labels = {
    fetching: 'Fetching your uploaded world',
    checking: 'Checking the world’s files',
    players: 'Checking players and their inventories',
    mods: 'Finding the mods your server needs',
    packing: 'Preparing and saving your world',
    saving: 'Finishing and keeping your world safe',
  } as const
  for (const [step, label] of Object.entries(labels))
    expect(
      readingProgress(progress({ step: step as WorldImportProgress['step'] }), 10 * SECOND_MS).label,
    ).toBe(label)
  expect(readingProgress(null, 0)).toEqual({
    label: 'Waiting to prepare your world',
    detail: 'Your upload is safe. Waiting for a worker.',
    percent: null,
  })
  expect(readingElapsed(60)).toBe('1m 0s')
  expect(readingElapsed(61.9)).toBe('1m 1s')
  expect(readingProgress(progress(), -SECOND_MS).detail).toContain('0s elapsed')
})

test('a prediction needs fresh positive measurements for two seconds of this stage', () => {
  const measured = progress({ updatedAt: at(2 * SECOND_MS) })
  expect(readingProgress(measured, 2 * SECOND_MS).detail).toContain('left in this step')
  expect(readingProgress(measured, 17 * SECOND_MS).detail).not.toContain('left')
  expect(readingProgress(progress({ bytes: 0 }), 10 * SECOND_MS).detail).not.toContain('left')
  expect(readingProgress(progress({ updatedAt: at(SECOND_MS) }), SECOND_MS).detail).not.toContain('left')
  const unknown = readingProgress(progress({ totalBytes: null }), 10 * SECOND_MS)
  expect(unknown.detail).toBe('10s elapsed')
  expect(unknown.percent).toBeNull()
})
