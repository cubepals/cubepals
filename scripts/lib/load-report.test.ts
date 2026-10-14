// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The load test's report: steps timed by the runs that worked, Fly's machine events turned into
 * hours, failures grouped, the first limit a run met, chaos worst first, and a wait's parts.
 */
import { describe, expect, test } from 'bun:test'
import { HOUR_MS } from '@blockly/contracts/durations'
import type { StepRecord } from './load-player.ts'
import {
  failuresOf,
  firstLimit,
  hoursBySize,
  partStats,
  runningMs,
  stepStats,
  worstFirst,
} from './load-report.ts'

const step = (over: Partial<StepRecord>): StepRecord => ({
  player: 0,
  step: 'play',
  ok: true,
  ms: 1000,
  at: 0,
  ...over,
})

describe('the load test report', () => {
  test('times a step by the runs that worked, and counts the rest as failed', () => {
    const records = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => step({ ms: s * 1000, retries: 1 }))
    const [play] = stepStats([...records, step({ ok: false, ms: 99_000, error: 'no' })])
    expect(play).toEqual({
      step: 'play',
      count: 11,
      failed: 1,
      medianMs: 6000,
      p90Ms: 10_000,
      slowestMs: 10_000,
      retries: 10,
    })
  })

  test('counts a machine running from each start to the stop or suspend after it', () => {
    const events = [
      { status: 'created', timestamp: 0 },
      { status: 'started', timestamp: 10 },
      { status: 'suspended', timestamp: 40 },
      { status: 'started', timestamp: 100 },
      { status: 'stopped', timestamp: 130 },
      { status: 'started', timestamp: 200 },
    ]
    expect(runningMs(events, 250)).toBe(30 + 30 + 50)
  })

  test('adds machine hours up by size', () => {
    const hour = HOUR_MS
    const runs = [
      { app: 'a', machine: '1', size: 'shared-1x', runningMs: hour },
      { app: 'b', machine: '2', size: 'shared-1x', runningMs: hour / 2 },
      { app: 'c', machine: '3', size: 'performance-2x', runningMs: hour },
    ]
    expect(hoursBySize(runs)).toEqual([
      { size: 'shared-1x', machines: 2, hours: 1.5 },
      { size: 'performance-2x', machines: 1, hours: 1 },
    ])
  })

  test('groups failures that differ only by ids and numbers', () => {
    const failures = failuresOf([
      step({ ok: false, error: 'never running within 900s; server 1f2e3d4c-0000-4000-8000-000000000001' }),
      step({ ok: false, error: 'never running within 600s; server 1f2e3d4c-0000-4000-8000-000000000002' }),
      step({ ok: false, step: 'sign up', error: 'no email with a verify-email link' }),
    ])
    expect(failures.map((f) => [f.count, f.steps])).toEqual([
      [2, ['play']],
      [1, ['sign up']],
    ])
  })

  test('names the first limit a failure met, by when it failed', () => {
    const records = [
      step({ ok: false, at: 50, error: 'no email with a verify-email link' }),
      step({ ok: false, at: 10, error: 'signing up answered 429' }),
    ]
    expect(firstLimit(records)?.limit).toBe('rate limits')
  })

  test('puts what lost someone something before what only interrupted them', () => {
    const finding = (verdict: 'fine' | 'stuck' | 'lost something' | 'interrupted', at: number) => ({
      act: 'a',
      player: 0,
      did: '',
      verdict,
      at,
    })
    const sorted = worstFirst([
      finding('fine', 1),
      finding('interrupted', 2),
      finding('lost something', 3),
      finding('stuck', 4),
    ])
    expect(sorted.map((f) => f.verdict)).toEqual(['lost something', 'stuck', 'interrupted', 'fine'])
  })

  test('times each part of a wait over many', () => {
    const parts = [
      { part: 'queued', ms: 100 },
      { part: 'booting', ms: 5000 },
      { part: 'queued', ms: 300 },
    ]
    expect(partStats(parts).map((p) => [p.part, p.count, p.slowestMs])).toEqual([
      ['queued', 2, 300],
      ['booting', 1, 5000],
    ])
  })
})
