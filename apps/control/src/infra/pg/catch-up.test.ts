// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A worker that starts after hours stopped runs each job that went stale once at once, the spend
 * watchdog and the heartbeat `/api/health` waits on among them, and leaves the fresh ones to their
 * schedule.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import type { PgBoss } from 'pg-boss'
import { JobRecord } from '../../app/platform/job-record.ts'
import type { Schedule } from '../../app/ports/jobs.ts'
import { freshDatabase, hasDatabase } from '../../testing/fleet.ts'
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

  test('names the jobs whose last success is older than their interval, or that have none', () => {
    const succeeded = new Map([
      ['worker-heartbeat', ago(5 * HOUR_MS)],
      ['spend-watchdog', ago(5 * HOUR_MS)],
      ['orphans', ago(10 * MINUTE_MS)],
    ])
    expect(catchUp(schedules, succeeded, now)).toEqual([
      'worker-heartbeat',
      'spend-watchdog',
      'retention-sweep',
    ])
  })

  test('leaves alone a job that ran within its interval', () => {
    const fresh = new Map(schedules.map((s) => [s.job, ago(s.everySeconds * 1000 - 1000)]))
    expect(catchUp(schedules, fresh, now)).toEqual([])
  })
})

describe.skipIf(!hasDatabase)('a worker that starts after being stopped for hours', () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>
  let boss: PgBoss
  beforeAll(async () => {
    database = await freshDatabase()
  }, 30_000)
  afterAll(async () => {
    await boss?.stop({ graceful: false })
    await database?.drop()
  })

  test('runs what went stale within seconds, whichever minute it starts in', async () => {
    boss = await startBoss(database.url)
    const record = new JobRecord({ db: database.db })
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
        'joins-sweep',
        'signals',
        'spend-watchdog',
        'creates-room',
        'usage-close',
        'provider-tags',
        'runtime-upkeep',
        'insight-send',
      ] as const
    ).map((job): Schedule => ({ job, run: async () => void ran.push(job) }))
    // Stopped for two days: every job last succeeded then.
    const stale = new Date(Date.now() - 2 * DAY_MS)
    await record.scheduled(
      [...schedules.map((s) => s.job), 'worker-heartbeat'].map((job) => ({ job, everySeconds: 60 })),
      stale,
    )
    await Promise.all(
      [...schedules.map((s) => s.job), 'worker-heartbeat'].map((job) => record.succeeded(job, stale)),
    )
    const started = Date.now()
    const running = await workSchedules(boss, schedules, record)
    try {
      while (!(ran.includes('spend-watchdog') && ran.length >= schedules.length)) {
        if (Date.now() - started > 20_000) throw new Error(`Only ${ran.join(', ')} ran`)
        await Bun.sleep(50)
      }
      // Neither waited for a minute's tick (the next one is at most a minute away, and it is the
      // ten-minute one that spend waits on).
      expect(Date.now() - started).toBeLessThan(20_000)
    } finally {
      await running.stop()
    }
  }, 40_000)
})
