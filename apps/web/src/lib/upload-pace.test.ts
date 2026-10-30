// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The words under an upload's bar: speed over the last seconds, and time left said roughly. */
import { describe, expect, test } from 'bun:test'
import { HOUR_S, MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import { keptSamples, paceLine, type Sample, speedOf, timeLeft } from './upload-pace.ts'

const MB = 1024 ** 2

/** An upload at a steady `perSecond`, sampled each second for `seconds`. */
const steady = (perSecond: number, seconds: number): Sample[] =>
  Array.from({ length: seconds + 1 }, (_, i) => ({ at: i * SECOND_MS, sent: i * perSecond }))

describe('the speed', () => {
  test('isn’t said until the upload has run long enough to tell', () => {
    expect(speedOf(steady(MB, 1))).toBeNull()
    expect(speedOf(steady(MB, 2))).toBe(MB)
  })

  test('follows the last few seconds, not the whole upload', () => {
    let samples: Sample[] = []
    for (const sample of steady(4 * MB, 20)) samples = keptSamples(samples, sample)
    // The connection drops to a quarter of its speed for the next 20 seconds.
    const at = 20 * SECOND_MS
    const sent = 80 * MB
    for (let i = 1; i <= 20; i++)
      samples = keptSamples(samples, { at: at + i * SECOND_MS, sent: sent + i * MB })
    expect(speedOf(samples)).toBe(MB)
  })
})

describe('the time left', () => {
  test('is said roughly, in the words a person would use', () => {
    expect(timeLeft(4)).toBe('A few seconds left')
    expect(timeLeft(42)).toBe('About 50 seconds left')
    expect(timeLeft(80)).toBe('About a minute left')
    expect(timeLeft(5 * MINUTE_S)).toBe('About 5 minutes left')
    expect(timeLeft(HOUR_S)).toBe('About 1 hour left')
    expect(timeLeft(2 * HOUR_S + 15 * MINUTE_S)).toBe('About 2 hours 15 min left')
  })
})

describe('the line under the bar', () => {
  test('says how much has gone, how fast and how long is left', () => {
    expect(paceLine(steady(4 * MB, 10), 400 * MB)).toBe('40 MB of 400 MB · 4 MB/s · About 2 minutes left')
  })

  test('says it is still working out the time at the start', () => {
    expect(paceLine([{ at: 0, sent: 0 }], 400 * MB)).toBe('0 KB of 400 MB · Working out the time left')
  })

  test('says it is waiting when nothing has gone for a while', () => {
    const stalled = [
      { at: 0, sent: 10 * MB },
      { at: 5 * SECOND_MS, sent: 10 * MB },
    ]
    expect(paceLine(stalled, 400 * MB)).toBe('10 MB of 400 MB · Waiting for the connection')
  })

  test('says it is finishing once every byte has gone', () => {
    expect(paceLine(steady(100 * MB, 4), 400 * MB)).toBe('400 MB of 400 MB · Finishing')
  })
})
