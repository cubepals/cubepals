// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading the scheduled jobs' cron expressions as their minutes come, in UTC, and starting the
 * passes a worker takes.
 */
import { describe, expect, test } from 'bun:test'
import { due, everyMinute, tick } from './ticker.ts'

const at = (iso: string) => new Date(iso)

describe('a cron expression', () => {
  test('names its minutes, in UTC', () => {
    expect(due('* * * * *', at('2026-10-15T23:41:00Z'))).toBe(true)
    expect(due('*/10 * * * *', at('2026-10-15T23:40:00Z'))).toBe(true)
    expect(due('*/10 * * * *', at('2026-10-15T23:41:00Z'))).toBe(false)
    expect(due('*/5 * * * *', at('2026-10-15T23:55:00Z'))).toBe(true)
    expect(due('47 * * * *', at('2026-10-15T08:47:00Z'))).toBe(true)
    expect(due('47 * * * *', at('2026-10-15T08:48:00Z'))).toBe(false)
    expect(due('13 6 * * *', at('2026-10-15T06:13:00Z'))).toBe(true)
    expect(due('13 6 * * *', at('2026-10-15T07:13:00Z'))).toBe(false)
    expect(due('0,30 * * * *', at('2026-10-15T07:30:00Z'))).toBe(true)
  })

  test('written any other way is refused, rather than never sent', () => {
    expect(() => due('* * * *', at('2026-10-15T00:00:00Z'))).toThrow('five-field')
    expect(() => due('1-5 * * * *', at('2026-10-15T00:00:00Z'))).toThrow('not read here')
    expect(() => due('61 * * * *', at('2026-10-15T00:00:00Z'))).toThrow('not read here')
  })
})

describe('the ticker', () => {
  test('claims what is due in the minute a worker starts in, at once, and starts what it is given', async () => {
    const asked: string[][] = []
    const started: string[] = []
    // Every minute is due for one; the other is due a minute that is never now.
    const stop = everyMinute(
      {
        claim: async (names) => {
          asked.push(names)
          return names
        },
        start: (name) => void started.push(name),
      },
      [
        ['each-minute', '* * * * *'],
        ['never-now', `0 0 1 1 ${(new Date().getUTCDay() + 1) % 7}`],
      ],
    )
    try {
      await Bun.sleep(50)
      expect(asked).toEqual([['each-minute']])
      expect(started).toEqual(['each-minute'])
    } finally {
      stop()
    }
  })

  test('starts only the passes it is given, those another worker took being left to it', async () => {
    const started: string[] = []
    await tick(
      { claim: async () => ['mine'], start: (name) => void started.push(name) },
      [
        ['mine', '* * * * *'],
        ['theirs', '* * * * *'],
      ],
      new Date(),
    )
    expect(started).toEqual(['mine'])
  })

  test('goes on to the next minute when a claim hangs', async () => {
    let asked = 0
    const started = Date.now()
    await tick(
      {
        claim: () => {
          asked++
          return new Promise(() => {})
        },
        start: () => {},
      },
      [['hangs', '* * * * *']],
      new Date(),
      100,
    )
    expect(asked).toBe(1)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
