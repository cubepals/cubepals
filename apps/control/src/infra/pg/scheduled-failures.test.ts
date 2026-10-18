// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A scheduled job that throws is said where an operator looks: the worker logs each failed pass,
 * naming the job, and writes it down for the alerts and the health check, beside pg-boss marking
 * its job failed.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import type { PgBoss } from 'pg-boss'
import type { Schedule, ScheduledJob } from '../../app/ports/jobs.ts'
import { startBoss, workSchedules } from './jobs.ts'

const base = process.env.DATABASE_URL

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
  'spend-watchdog',
  'creates-room',
  'usage-close',
  'provider-tags',
  'runtime-upkeep',
  'insight-send',
]

describe.skipIf(!base)('a scheduled job that fails', () => {
  const name = `blockly_test_${randomBytes(5).toString('hex')}`
  let url: string
  let boss: PgBoss
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
    const u = new URL(base as string)
    u.pathname = `/${name}`
    url = u.toString()
  }, 30_000)
  afterAll(async () => {
    await boss?.stop({ graceful: false })
    const cleanup = new pg.Client({ connectionString: base })
    await cleanup.connect()
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await cleanup.end()
  })

  test('is said somewhere an operator would see it', async () => {
    boss = await startBoss(url, { retryDelaySeconds: 0 })
    const ran: string[] = []
    const schedules: Schedule[] = JOBS.map((job) => ({
      job,
      run: async () => {
        if (job !== 'spend-watchdog') return
        ran.push(job)
        throw new Error('the provider could not be read')
      },
    }))
    const recorded: string[] = []
    await workSchedules(boss, schedules, {
      scheduled: async (jobs) => void recorded.push(`scheduled ${jobs.length}`),
      lastSucceeded: async () => new Map(),
      succeeded: async (job) => void recorded.push(`succeeded ${job}`),
      failed: async (job, _at, error) => void recorded.push(`failed ${job}: ${error}`),
    })
    const errors = spyOn(console, 'error')
    const warns = spyOn(console, 'warn')
    const bossErrors: unknown[] = []
    boss.on('error', (e) => bossErrors.push(e))
    try {
      await boss.send('spend-watchdog', {})
      const sent = Date.now()
      while (ran.length === 0 && Date.now() - sent < 10_000) await Bun.sleep(50)
      await Bun.sleep(1_000)
      // At a tenth minute the ticker sends it too, as the worker starts.
      expect(ran).toContain('spend-watchdog')
      const said = [...errors.mock.calls, ...warns.mock.calls].some((call) =>
        call.some(
          (part) =>
            String(part instanceof Error ? part.message : part).includes('spend-watchdog') ||
            String(part instanceof Error ? part.message : part).includes('could not be read'),
        ),
      )
      // The log, or pg-boss's 'error' event (which main.node.ts logs), hears of it.
      expect({ said, bossErrors: bossErrors.length > 0 }).not.toEqual({ said: false, bossErrors: false })
      // And written down, for the alerts and the health check: every job, the heartbeat among them.
      expect(recorded).toContain(`scheduled ${JOBS.length + 1}`)
      expect(recorded).toContain('failed spend-watchdog: the provider could not be read')
      expect(recorded).not.toContain('succeeded spend-watchdog')
    } finally {
      errors.mockRestore()
      warns.mockRestore()
    }
  }, 30_000)
})
