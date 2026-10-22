// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the health check reads of the jobs' records is their progress and nothing else: the SQL names
 * those columns, only the sweeps it holds the control plane to come back, and a long error kept on
 * a job stays in the database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPool, schema } from '@blockly/db'
import { drizzle } from 'drizzle-orm/node-postgres'
import { freshDatabase, hasDatabase } from '../../testing/fleet.ts'
import { KEY_SWEEPS } from './job-record.ts'
import { loadJobProgress } from './persistence.ts'

describe.skipIf(!hasDatabase)('job progress', () => {
  let drop: () => Promise<void>
  let pool: ReturnType<typeof createPool>
  let caught: string[] = []
  let db: ReturnType<typeof drizzle<typeof schema>>
  const at = new Date('2026-01-01T00:00:00Z')

  beforeAll(async () => {
    const fresh = await freshDatabase()
    drop = fresh.drop
    pool = createPool(fresh.url, 1)
    db = drizzle(pool, { schema, logger: { logQuery: (query) => caught.push(query) } })
    await db.insert(schema.jobHealth).values([
      ...[...KEY_SWEEPS, 'catalog-refresh', 'pack-checks'].map((job) => ({
        job,
        everySeconds: 60,
        firstSeenAt: at,
        lastSucceededAt: at,
        lastFailedAt: at,
        lastError: 'a long complaint '.repeat(500),
        failures: 2,
      })),
    ])
  })

  afterAll(async () => {
    await pool.end()
    await drop()
  })

  test('the sweeps come back with when they ran, and not what they said', async () => {
    caught = []
    const rows = await loadJobProgress(db, KEY_SWEEPS)
    expect(rows.map((r) => r.job).sort()).toEqual([...KEY_SWEEPS].sort())
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual(['everySeconds', 'firstSeenAt', 'job', 'lastSucceededAt'])
    expect(caught).toHaveLength(1)
    for (const left of [
      'last_error',
      'last_failed_at',
      'failures',
      'claimed_at',
      'claimed_until',
      'run_asked_at',
    ])
      expect(caught[0]).not.toContain(left)
  })

  test('without names, every job comes back, still without the errors', async () => {
    const rows = await loadJobProgress(db)
    expect(rows).toHaveLength(KEY_SWEEPS.length + 2)
    expect(JSON.stringify(rows)).not.toContain('complaint')
  })
})
