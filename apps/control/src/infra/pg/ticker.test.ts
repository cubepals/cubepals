// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading the scheduled jobs' cron expressions as their minutes come, in UTC, and the one job a
 * minute two workers send between them.
 */
import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { MINUTE_S } from '@blockly/contracts/durations'
import pg from 'pg'
import { startBoss } from './jobs.ts'
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
  test('sends what is due in the minute a worker starts in, at once', async () => {
    const sent: string[] = []
    const boss = {
      send: async (name: string) => {
        sent.push(name)
        return null
      },
    } as never
    // Every minute is due for one; the other is due a minute that is never now.
    const stop = everyMinute(boss, [
      ['each-minute', '* * * * *'],
      ['never-now', `0 0 1 1 ${(new Date().getUTCDay() + 1) % 7}`],
    ])
    try {
      await Bun.sleep(50)
      expect(sent).toEqual(['each-minute'])
    } finally {
      stop()
    }
  })

  test('goes on to the next minute when a send hangs', async () => {
    let asked = 0
    const boss = {
      send: () => {
        asked++
        return new Promise(() => {})
      },
    } as never
    const started = Date.now()
    await tick(boss, [['hangs', '* * * * *']], new Date(), 100)
    expect(asked).toBe(1)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

const base = process.env.DATABASE_URL

describe.skipIf(!base)('a scheduled job sent by two workers in one minute', () => {
  test('is one job', async () => {
    const name = `blockly_test_${randomBytes(5).toString('hex')}`
    const admin = new pg.Client({ connectionString: base })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${name}`)
    const url = new URL(base as string)
    url.pathname = `/${name}`
    const [one, two] = [await startBoss(url.toString()), await startBoss(url.toString())]
    try {
      await one.createQueue('tick-test', { policy: 'singleton' })
      // The first already ran when the second worker sends: the minute still holds one job.
      expect(await one.send('tick-test', {}, { singletonSeconds: MINUTE_S })).not.toBeNull()
      const [job] = await one.fetch('tick-test')
      await one.complete('tick-test', job?.id ?? '')
      expect(await two.send('tick-test', {}, { singletonSeconds: MINUTE_S })).toBeNull()
    } finally {
      await one.stop({ graceful: false })
      await two.stop({ graceful: false })
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    }
  }, 30_000)
})
