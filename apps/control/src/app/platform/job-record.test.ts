// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The record of the platform's recurring work: a scheduled job that keeps failing or goes quiet is
 * an admin alert that clears itself, the realtime certificate is one a week before it lapses, and
 * `/api/health` is healthy only while the worker's key sweeps are recent.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { PlatformHealth } from './health.ts'
import { JobRecord } from './job-record.ts'

let h: Harness
let record: JobRecord

beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness()
  record = new JobRecord({ db: h.db })
}, 30_000)
afterAll(async () => {
  if (hasDatabase) await h.close()
})

/** A sweep, its emails' log lines kept out of the output. */
async function sweep(at: Date) {
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    return await h.app.alerts.sweep(at)
  } finally {
    quiet.mockRestore()
  }
}

describe.skipIf(!hasDatabase)('the record of scheduled jobs', () => {
  const t0 = new Date('2026-03-01T00:00:00Z')
  const at = (ms: number) => new Date(t0.getTime() + ms)

  test('a job that keeps failing is an alert naming it, which clears once it succeeds', async () => {
    await record.scheduled([{ job: 'orphans', everySeconds: HOUR_MS / 1000 }], t0)
    await record.failed('orphans', at(MINUTE_MS), 'the provider answered 500')
    await record.failed('orphans', at(2 * MINUTE_MS), 'the provider answered 500')
    expect((await sweep(at(3 * MINUTE_MS))).raised).not.toContain('jobs_failing')

    await record.failed('orphans', at(3 * MINUTE_MS), 'the provider answered 500')
    expect((await sweep(at(4 * MINUTE_MS))).raised).toContain('jobs_failing')
    const [alert] = await h.db.select().from(schema.platformAlerts)
    expect(alert?.summary).toContain('orphans failed 3 times in a row (the provider answered 500)')

    await record.succeeded('orphans', at(5 * MINUTE_MS))
    expect((await sweep(at(6 * MINUTE_MS))).cleared).toContain('jobs_failing')
  })

  test('a job with no success in three of its intervals is an alert too', async () => {
    expect((await sweep(at(5 * MINUTE_MS + 3 * HOUR_MS))).raised).not.toContain('jobs_failing')
    expect((await sweep(at(6 * MINUTE_MS + 3 * HOUR_MS))).raised).toContain('jobs_failing')
    await record.succeeded('orphans', at(7 * MINUTE_MS + 3 * HOUR_MS))
    expect((await sweep(at(8 * MINUTE_MS + 3 * HOUR_MS))).cleared).toContain('jobs_failing')
  })

  test('a job no longer scheduled is forgotten', async () => {
    await record.scheduled([{ job: 'reconcile', everySeconds: 60 }], at(DAY_MS))
    const jobs = (await h.db.select().from(schema.jobHealth)).map((row) => row.job)
    expect(jobs).toContain('reconcile')
    expect(jobs).not.toContain('orphans')
  })
})

describe.skipIf(!hasDatabase)('the control plane’s liveness', () => {
  test('is healthy only while the heartbeat, the alerts and the spend watchdog are recent', async () => {
    const now = new Date('2026-04-01T12:00:00Z')
    await record.scheduled(
      [
        { job: 'worker-heartbeat', everySeconds: 60 },
        { job: 'admin-alerts', everySeconds: 300 },
        { job: 'spend-watchdog', everySeconds: 600 },
      ],
      new Date(now.getTime() - DAY_MS),
    )
    const health = () => new PlatformHealth({ db: h.db }).liveness(now)
    expect(await health()).toEqual({
      ok: false,
      stale: ['worker-heartbeat', 'admin-alerts', 'spend-watchdog'],
    })
    for (const job of ['admin-alerts', 'spend-watchdog'])
      await record.succeeded(job, new Date(now.getTime() - 10 * MINUTE_MS))
    await record.succeeded('worker-heartbeat', new Date(now.getTime() - 4 * MINUTE_MS))
    expect(await health()).toEqual({ ok: false, stale: ['worker-heartbeat'] })
    await record.succeeded('worker-heartbeat', new Date(now.getTime() - MINUTE_MS))
    expect(await health()).toEqual({ ok: true, stale: [] })
  })
})

describe.skipIf(!hasDatabase)('the realtime certificate', () => {
  test('is an alert a week before it lapses, and not before', async () => {
    const expiresAt = new Date('2026-06-01T00:00:00Z')
    await h.db.insert(schema.realtimeCertificate).values({
      id: 1,
      sha256: 'ab',
      expiresAt,
      hostname: 'rt.example.test',
      certificatePem: 'pem',
      privateKeySealed: 'sealed',
      issuedAt: new Date(expiresAt.getTime() - 90 * DAY_MS),
    })
    expect((await sweep(new Date(expiresAt.getTime() - 8 * DAY_MS))).raised).not.toContain(
      'realtime_certificate_expiring',
    )
    expect((await sweep(new Date(expiresAt.getTime() - 6 * DAY_MS))).raised).toContain(
      'realtime_certificate_expiring',
    )
  })
})
