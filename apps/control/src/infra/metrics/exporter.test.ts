// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Prometheus would scrape: the exporter serves the figures the code counts and the ones the
 * database holds, under the names `docs/metrics.md` lists. The provider is the process's, set once,
 * so everything is read from the one scrape, which no label in can name a server, a player, a
 * person or an address.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createPool, type Db, schema } from '@blockly/db'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { PgBoss } from 'pg-boss'
import { installTelemetry } from '../../app/platform/telemetry.ts'
import type { Telemetry } from '../../app/ports/telemetry.ts'
import { measured } from '../../interfaces/http/measured.ts'
import { freshDatabase, hasDatabase } from '../../testing/fleet.ts'
import { startBoss } from '../pg/jobs.ts'
import { serveMetrics } from './exporter.ts'

let db: Db
let pool: Pool
let drop: (() => Promise<void>) | undefined
let boss: PgBoss | undefined
let stop: (() => Promise<void>) | undefined
let scrape = ''

/** What a request path, a job or a query could carry that must never become a label. */
const SERVER_ID = randomUUID()
const EMAIL = 'steve@example.test'
const PLAYER = 'Notch'
const ADDRESS = '203.0.113.9'

/** A listener with routes that take ids, names and addresses, measured as the real ones are. */
const listener = new Hono()
  .use('*', measured('api'))
  .get('/api/public/servers/:slug', (c) => c.json({ slug: c.req.param('slug') }))
  .get('/api/public/names/:name/face.png', (c) => c.body(null, 404))
  .get('/api/health/live', (c) => c.json({ ok: true }))
  .get('/api/boom/:id', () => {
    throw new Error('boom')
  })
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

/**
 * Requests with ids, names and addresses in their paths, a procedure, a refused browser, a query
 * that fails, and a job that does, then waits until pg-boss has worked both jobs.
 */
async function drive(telemetry: Telemetry, boss: PgBoss) {
  for (const path of [
    `/api/public/servers/${SERVER_ID}`,
    `/api/public/names/${PLAYER}/face.png`,
    `/api/public/servers/${EMAIL}?from=${ADDRESS}`,
    `/api/boom/${SERVER_ID}`,
    `/${ADDRESS}/${PLAYER}`,
    '/api/health/live',
  ])
    await listener.request(path, { headers: { 'x-forwarded-for': ADDRESS } })
  await listener.request(`/api/public/servers/${PLAYER}`, { method: 'PROPFIND' })
  telemetry.procedureServed('servers.list', 200, 30)
  telemetry.procedureServed('servers.list', 404, 5)
  telemetry.realtimeConnected('websocket', 'ticket', 2)
  await pool.query(`select 1 from minecraft_servers where id = '${SERVER_ID}'`)
  await pool.query('select 1 / 0').catch(() => {})
  await boss.createQueue('ok')
  await boss.createQueue('fails')
  await boss.work('ok', async () => {})
  await boss.work('fails', async () => {
    throw new Error(`no such server ${SERVER_ID}`)
  })
  await boss.send('ok', { serverId: SERVER_ID })
  await boss.send('fails', { serverId: SERVER_ID }, { retryLimit: 0 })
  // The workers ask every two seconds; Postgres's own figures are read as the exporter starts.
  for (let tries = 0; tries < 40 && !/messaging_process_duration_count\{[^}]*"fails"/.test(scrape); tries++) {
    await Bun.sleep(250)
    scrape = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text()
  }
}

beforeAll(async () => {
  if (!hasDatabase) return
  const fresh = await freshDatabase()
  db = fresh.db
  pool = createPool(fresh.url)
  drop = fresh.drop
  const sender = await startBoss(fresh.url, { maintains: false })
  await sender.createQueue('probe')
  await sender.send('probe', {})
  await sender.stop({ graceful: false })
  await db.insert(schema.users).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' })
  await server('a', 'fra', 'running')
  await server('b', 'fra', 'stopped')
  await server('c', 'iad', 'stored')
  await server('d', 'iad', 'stopped', true)
  boss = await startBoss(fresh.url, { maintains: false })
  const served = serveMetrics(`127.0.0.1:${PORT}`, ['worker'], { pool, boss, url: fresh.url })
  stop = served.stop
  const telemetry = installTelemetry(served.telemetry)
  await drive(telemetry, boss)
  telemetry.operationEnded('start', 'succeeded', 42_000)
  telemetry.operationFailed('start', 'booting')
  telemetry.wakeAnswered('denied', 'quota')
  telemetry.wakeCompleted('fra', 20_000)
  telemetry.joinCompleted('held', 'fra', 25_000)
  scrape = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text()
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await boss?.stop({ graceful: false })
  await stop?.()
  await pool?.end()
  await drop?.()
})

describe.skipIf(!hasDatabase)('the metrics endpoint', () => {
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

describe.skipIf(!hasDatabase)('the metrics endpoint, of requests, the database and the process', () => {
  test('counts requests by route template, method and status class, and times all but health', () => {
    const labels = (route: string, method: string, status: string) =>
      `{listener="api",http_route="${route}",http_request_method="${method}",status_class="${status}"}`
    expect(scrape).toContain(
      `cubepals_http_requests_total${labels('/api/public/servers/:slug', 'GET', '2xx')} 2`,
    )
    expect(scrape).toContain(`cubepals_http_requests_total${labels('/*', '_OTHER', '4xx')} 1`)
    expect(scrape).toContain(`cubepals_http_requests_total${labels('/api/boom/:id', 'GET', '5xx')} 1`)
    expect(scrape).toContain(`cubepals_http_requests_total${labels('/api/health/live', 'GET', '2xx')} 1`)
    expect(scrape).toContain(
      `http_server_request_duration_count${labels('/api/public/servers/:slug', 'GET', '2xx')} 2`,
    )
    expect(scrape).not.toContain(
      'http_server_request_duration_count{listener="api",http_route="/api/health/live"',
    )
    expect(scrape).toContain(
      'rpc_server_call_duration_count{rpc_system="trpc",rpc_method="servers.list",status_class="4xx"} 1',
    )
    expect(scrape).toContain(
      'cubepals_realtime_connect_duration_seconds_count{transport="websocket",outcome="ticket"} 1',
    )
  })

  test('times queries by statement, counts failures by SQLSTATE class, and reads the pools', () => {
    expect(scrape).toMatch(/db_client_operation_duration_count\{[^}]*db_operation_name="SELECT"\} [1-9]/)
    expect(scrape).toMatch(
      /db_client_operation_duration_count\{[^}]*db_operation_name="SELECT",error_type="22"\} 1/,
    )
    expect(scrape).toContain(
      'db_client_connection_max{db_client_connection_pool_name="queries",role="worker"} 10',
    )
    expect(scrape).toMatch(
      /db_client_connection_count\{db_client_connection_pool_name="jobs",role="worker",db_client_connection_state="used"\} \d/,
    )
    expect(scrape).toMatch(
      /db_client_connection_pending_requests\{db_client_connection_pool_name="queries",role="worker"\} 0/,
    )
  })

  test('reads Postgres’s own figures', () => {
    expect(scrape).toMatch(/^cubepals_db_connections [1-9]/m)
    expect(scrape).toMatch(/^cubepals_db_max_connections [1-9]/m)
    expect(scrape).toMatch(/^cubepals_db_oldest_transaction_seconds \d/m)
    expect(scrape).toMatch(/^cubepals_db_cache_hit_ratio (0|1|0\.\d+)$/m)
    expect(scrape).toMatch(/^cubepals_db_size_bytes [1-9]/m)
    // A database with no replica has no lag to report.
    expect(scrape).not.toMatch(/^cubepals_db_replication_lag_seconds /m)
  })

  test('has pg-boss time each job by queue, and say which failed', () => {
    expect(scrape).toMatch(/messaging_process_duration_count\{[^}]*messaging_destination_name="ok"[^}]*\} 1/)
    expect(scrape).toMatch(
      /messaging_process_duration_count\{[^}]*messaging_destination_name="fails"[^}]*error_type="Error"[^}]*\} 1/,
    )
  })

  test('says how late the event loop runs and how much heap is in use', () => {
    expect(scrape).toMatch(/cubepals_event_loop_lag_seconds_count\{role="worker"\} [1-9]/)
    expect(scrape).toMatch(/cubepals_heap_used_bytes\{role="worker"\} [1-9]/)
  })

  test('has no label that grows without bound: no id, name, email, address or raw path', () => {
    const values = [...scrape.matchAll(/\w+="([^"]*)"/g)].map((match) => match[1] ?? '')
    expect(values.length).toBeGreaterThan(50)
    for (const value of values) {
      expect(value).not.toContain(SERVER_ID)
      expect(value).not.toContain(EMAIL)
      expect(value).not.toContain(PLAYER)
      expect(value).not.toContain(ADDRESS)
      expect(value).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|@|\d+\.\d+\.\d+\.\d+/)
    }
    // A path no route matched is counted as the catch-all, not as itself.
    expect(scrape).toContain(
      'cubepals_http_requests_total{listener="api",http_route="/*",http_request_method="GET"',
    )
  })
})
