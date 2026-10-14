// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When an empty running server goes to sleep, by the one rule the idle check and the server page
 * share, and how long its idle time is while room is tight.
 */
import { describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { bedtime, idleMinutesNow, WAKE_PROBATION_MS } from './idle.ts'

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 14, 0) + minutes * MINUTE_MS)

describe('when an empty server goes to sleep', () => {
  test('a world woken from its page gets its whole idle time from the wake, however long ago it was played', () => {
    // Played yesterday, put to sleep, woken from its page at 14:00: Free's ten minutes from then.
    const run = { startedAt: at(0), woken: false }
    expect(bedtime(run, at(-24 * 60), 10)).toEqual({ at: at(10), why: 'idle' })
  })

  test('a play in this run moves it on from that play', () => {
    const run = { startedAt: at(0), woken: false }
    expect(bedtime(run, at(25), 15)).toEqual({ at: at(40), why: 'idle' })
  })

  test('a world nobody has ever played counts from the wake', () => {
    expect(bedtime({ startedAt: at(0), woken: false }, null, 10)).toEqual({ at: at(10), why: 'idle' })
  })

  test('a world a connection woke and nobody joined has only the probation', () => {
    const run = { startedAt: at(0), woken: true }
    const probation = { at: new Date(at(0).getTime() + WAKE_PROBATION_MS), why: 'nobody_joined' as const }
    expect(bedtime(run, null, 10)).toEqual(probation)
    // Played before it slept is not a join: the probation still holds, on a plan that never sleeps too.
    expect(bedtime(run, at(-60), 10)).toEqual(probation)
    expect(bedtime(run, at(-60), null)).toEqual(probation)
  })

  test('a world a connection woke and somebody joined has its plan’s idle time from the join', () => {
    expect(bedtime({ startedAt: at(0), woken: true }, at(1), 10)).toEqual({ at: at(11), why: 'idle' })
  })

  test('a plan that never sleeps an idle server has no bedtime', () => {
    expect(bedtime({ startedAt: at(0), woken: false }, at(-60), null)).toBeNull()
  })

  test('without a run on record, only a play says when it last had company', () => {
    expect(bedtime(null, at(-5), 10)).toEqual({ at: at(5), why: 'idle' })
    expect(bedtime(null, null, 10)).toBeNull()
  })
})

describe('the idle time while room is tight', () => {
  const tight = { free: true, tight: true, tightMinutes: 3 }

  test('a free server nobody is on sleeps after the shorter time while room is tight', () => {
    expect(idleMinutesNow(10, tight)).toBe(3)
    expect(idleMinutesNow(10, { ...tight, tight: false })).toBe(10)
  })

  test('a paid server keeps its plan’s idle time however tight room is', () => {
    expect(idleMinutesNow(15, { ...tight, free: false })).toBe(15)
    expect(idleMinutesNow(null, { ...tight, free: false })).toBeNull()
  })

  test('it only ever shortens a plan’s idle time', () => {
    expect(idleMinutesNow(2, tight)).toBe(2)
  })
})
