// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Prometheus would scrape: the exporter serves the figures the code counts and the ones the
 * database holds, under the names `docs/metrics.md` lists. The provider is the process's, set once,
 * so everything is read from the one scrape.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createPool, type Db, schema } from '@blockly/db'
import type { Pool } from 'pg'
import { freshDatabase, hasDatabase } from '../../testing/fleet.ts'
import { startBoss } from '../pg/jobs.ts'
import { serveMetrics } from './exporter.ts'

let db: Db
let pool: Pool
let drop: (() => Promise<void>) | undefined
let scrape = ''
const PORT = 19464

async function server(
  name: string,
  region: string,
  status: 'running' | 'stopped' | 'stored',
  deleted = false,
) {
  await db.insert(schema.minecraftServers).values({
    ownerId: 'owner',
    name,
    slug: name,
    inviteCode: randomUUID(),
    regionKey: region,
    memoryTier: '4gb',
    status,
    createIdempotencyKey: randomUUID(),
    createdFrom: 'template',
    ...(deleted ? { deletedAt: new Date() } : {}),
  })
}

describe.skipIf(!hasDatabase)('the metrics endpoint', () => {
  beforeAll(async () => {
    const fresh = await freshDatabase()
    db = fresh.db
    pool = createPool(fresh.url)
    drop = fresh.drop
    const boss = await startBoss(fresh.url, { maintains: false })
    await boss.createQueue('probe')
    await boss.send('probe', {})
    await boss.stop({ graceful: false })
    await db.insert(schema.users).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' })
    await server('a', 'fra', 'running')
    await server('b', 'fra', 'stopped')
    await server('c', 'iad', 'stored')
    await server('d', 'iad', 'stopped', true)
    const telemetry = serveMetrics(`127.0.0.1:${PORT}`, ['worker'], pool)
    telemetry.operationEnded('start', 'succeeded', 42_000)
    telemetry.operationFailed('start', 'booting')
    telemetry.wakeAnswered('denied', 'quota')
    telemetry.wakeCompleted('fra', 20_000)
    telemetry.joinCompleted('held', 'fra', 25_000)
    scrape = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text()
  })

  afterAll(async () => {
    await pool?.end()
    await drop?.()
  })

  test('says how long operations, wakes and joins took, as histograms', () => {
    expect(scrape).toContain(
      'cubepals_operation_duration_seconds_bucket{kind="start",outcome="succeeded",le="60"} 1',
    )
    expect(scrape).toContain('cubepals_wake_duration_seconds_bucket{edge_region="fra",le="30"} 1')
    expect(scrape).toContain('cubepals_join_duration_seconds_sum{path="held",edge_region="fra"} 25')
  })

  test('counts failures by the step they reached and wake answers by why', () => {
    expect(scrape).toMatch(/cubepals_operation_failures(_total)?\{kind="start",step="booting"\} 1/)
    expect(scrape).toMatch(/cubepals_wake_answers(_total)?\{outcome="denied",reason="quota"\} 1/)
  })

  test('reads servers by state and region, and the queue, from the database', () => {
    expect(scrape).toContain('cubepals_servers{state="running",server_region="fra"} 1')
    expect(scrape).toContain('cubepals_servers{state="asleep",server_region="fra"} 1')
    expect(scrape).toContain('cubepals_servers{state="resting",server_region="iad"} 1')
    expect(scrape).toContain('cubepals_servers{state="trashed",server_region="iad"} 1')
    expect(scrape).toContain('cubepals_queue_depth{queue="probe"} 1')
  })
})
