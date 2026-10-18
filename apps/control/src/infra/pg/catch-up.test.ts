// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A worker that starts after hours stopped runs each job that went stale once at once, the spend
 * watchdog and the heartbeat `/api/health` waits on among them, and leaves the fresh ones to their
 * schedule.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import pg from 'pg'
import type { PgBoss } from 'pg-boss'
import type { Schedule } from '../../app/ports/jobs.ts'
import { catchUp } from './catch-up.ts'
import { startBoss, workSchedules } from './jobs.ts'

const now = new Date('2026-10-18T20:04:47Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

describe('catching up', () => {
  const schedules = [
    { job: 'worker-heartbeat', everySeconds: 60 },
    { job: 'spend-watchdog', everySeconds: 600 },
    { job: 'orphans', everySeconds: 3600 },
    { job: 'retention-sweep', everySeconds: 86_400 },
  ]

  test('sends the jobs whose last success is older than their interval, or that have none', async () => {
    const sent: string[] = []
    const woken: string[] = []
    const boss = {
      send: async (job: string) => {
        sent.push(job)
        return 'id'
      },
      notifyWorker: (worker: string) => void woken.push(worker),
    } as unknown as Pick<PgBoss, 'send' | 'notifyWorker'>
    const succeeded = new Map([
      ['worker-heartbeat', ago(5 * HOUR_MS)],
      ['spend-watchdog', ago(5 * HOUR_MS)],
      ['orphans', ago(10 * MINUTE_MS)],
    ])
    const caught = await catchUp(boss, schedules, succeeded, ['a', 'b'], now)
    expect(caught).toEqual(['worker-heartbeat', 'spend-watchdog', 'retention-sweep'])
    expect(sent).toEqual(caught)
    expect(woken).toEqual(['a', 'b'])
  })

  test('leaves alone a job that ran within its interval', async () => {
    const sent: string[] = []
    const boss = {
      send: async (job: string) => {
        sent.push(job)
        return 'id'
      },
      notifyWorker: () => {},
    } as unknown as Pick<PgBoss, 'send' | 'notifyWorker'>
    const fresh = new Map(schedules.map((s) => [s.job, ago(s.everySeconds * 1000 - 1000)]))
    expect(await catchUp(boss, schedules, fresh, [], now)).toEqual([])
    expect(sent).toEqual([])
  })

  test('goes on to the next job when one send fails', async () => {
    const boss = {
      send: async (job: string) => {
        if (job === 'spend-watchdog') throw new Error('the database went away')
        return 'id'
      },
      notifyWorker: () => {},
    } as unknown as Pick<PgBoss, 'send' | 'notifyWorker'>
    const originalError = console.error
    console.error = () => {}
    try {
      expect(await catchUp(boss, schedules, new Map(), [], now)).toEqual([
        'worker-heartbeat',
        'orphans',
        'retention-sweep',
      ])
    } finally {
      console.error = originalError
    }
  })
})

const base = process.env.DATABASE_URL

describe.skipIf(!base)('a worker that starts after being stopped for hours', () => {
  const name = `blockly_test_${randomBytes(5).toString('hex')}`
  let boss: PgBoss
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
  }, 30_000)
  afterAll(async () => {
    await boss?.stop({ graceful: false })
    const cleanup = new pg.Client({ connectionString: base })
    await cleanup.connect()
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await cleanup.end()
  })

  test('runs what went stale within seconds, whichever minute it starts in', async () => {
    const u = new URL(base as string)
    u.pathname = `/${name}`
    boss = await startBoss(u.toString())
    const ran: string[] = []
    const schedules = (
      [
        'reconcile',
        'drift',
        'relocations',
        'presence-sync',
        'idle-check',
        'session-check',
        'disk-check',
        'orphans',
        'purge-sweep',
        'expiry-sweep',
        'store-sweep',
        'retention-sweep',
        'catalog-refresh',
        'compat-pins',
        'malware-lists',
        'pack-checks',
        'curation',
        'backup-schedule',
        'artifact-gc',
        'standing-sweep',
        'extra-play-report',
        'listing-eligibility-sweep',
        'admin-alerts',
        'free-play-links',
        'known-addresses',
        'spend-watchdog',
        'creates-room',
        'usage-close',
        'provider-tags',
        'runtime-upkeep',
        'insight-send',
      ] as const
    ).map((job): Schedule => ({ job, run: async () => void ran.push(job) }))
    const succeeded: string[] = []
    // Stopped for five hours: every job last succeeded then.
    const last = new Map(schedules.map((s) => [s.job as string, new Date(Date.now() - 5 * HOUR_MS)]))
    last.set('worker-heartbeat', new Date(Date.now() - 5 * HOUR_MS))
    const started = Date.now()
    await workSchedules(boss, schedules, {
      scheduled: async () => {},
      lastSucceeded: async () => last,
      succeeded: async (job) => void succeeded.push(job),
      failed: async () => {},
    })
    while (!(succeeded.includes('spend-watchdog') && succeeded.includes('worker-heartbeat'))) {
      if (Date.now() - started > 20_000) throw new Error(`Only ${succeeded.join(', ')} ran`)
      await Bun.sleep(50)
    }
    // Neither waited for a minute's tick (the next one is at most a minute away, and it is the
    // ten-minute one that spend waits on).
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(ran).toContain('spend-watchdog')
  }, 40_000)
})
