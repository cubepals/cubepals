// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A scheduled job that throws is said where an operator looks: the worker logs each failed pass,
 * naming the job, and writes it down for the alerts and the health check.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { JobRecord } from '../../app/platform/job-record.ts'
import type { Schedule, ScheduledJob } from '../../app/ports/jobs.ts'
import { freshDatabase, hasDatabase } from '../../testing/fleet.ts'
import { startBoss, workSchedules } from './jobs.ts'

const JOBS: ScheduledJob[] = [
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
]

describe.skipIf(!hasDatabase)('a scheduled job that fails', () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>
  let boss: PgBoss
  beforeAll(async () => {
    database = await freshDatabase()
  }, 30_000)
  afterAll(async () => {
    await boss?.stop({ graceful: false })
    await database?.drop()
  })

  test('is said somewhere an operator would see it', async () => {
    boss = await startBoss(database.url, { retryDelaySeconds: 0 })
    const ran: string[] = []
    const schedules: Schedule[] = JOBS.map((job) => ({
      job,
      run: async () => {
        if (job !== 'spend-watchdog') return
        ran.push(job)
        throw new Error('the provider could not be read')
      },
    }))
    const errors = spyOn(console, 'error')
    const warns = spyOn(console, 'warn')
    // Nothing has succeeded yet, so every job runs as the worker starts.
    const running = await workSchedules(boss, schedules, new JobRecord({ db: database.db }))
    try {
      const sent = Date.now()
      while (ran.length === 0 && Date.now() - sent < 10_000) await Bun.sleep(50)
      await Bun.sleep(1_000)
      expect(ran).toContain('spend-watchdog')
      const said = [...errors.mock.calls, ...warns.mock.calls].some((call) =>
        call.some(
          (part) =>
            String(part instanceof Error ? part.message : part).includes('spend-watchdog') ||
            String(part instanceof Error ? part.message : part).includes('could not be read'),
        ),
      )
      expect(said).toBe(true)
      // And written down, for the alerts and the health check: every job, the heartbeat among them.
      const rows = await database.db.select().from(schema.jobHealth)
      expect(rows).toHaveLength(JOBS.length + 1)
      const [watchdog] = await database.db
        .select()
        .from(schema.jobHealth)
        .where(eq(schema.jobHealth.job, 'spend-watchdog'))
      expect(watchdog?.lastError).toBe('the provider could not be read')
      expect(watchdog?.lastSucceededAt).toBeNull()
    } finally {
      errors.mockRestore()
      warns.mockRestore()
      await running.stop()
    }
  }, 30_000)
})
