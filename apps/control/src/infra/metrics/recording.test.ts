// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The control plane's own wiring, as `main.node.ts` makes it, on a real database: the pool heard
 * from the start, telemetry installed with its database, and a slow query and a failed request
 * kept with whose they were, metrics served or not.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { createDb, createPool, schema } from '@blockly/db'
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import type { PgBoss } from 'pg-boss'
import { within } from '../../app/diagnostics/context.ts'
import { installTelemetry, requestServed } from '../../app/platform/telemetry.ts'
import { freshDatabase, hasDatabase } from '../../testing/fleet.ts'
import { serveMetrics } from './exporter.ts'

describe.skipIf(!hasDatabase)('what ran slow or failed, as a process keeps it', () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>
  let pool: Pool

  beforeAll(async () => {
    database = await freshDatabase()
    pool = createPool(database.url, 2, 'blockly-api')
  }, 30_000)

  afterAll(async () => {
    // Installed whole again, keeping nothing, for the files that run after this one.
    const { telemetry } = serveMetrics(undefined, ['api'], { pool, boss: {} as PgBoss, url: database.url })
    installTelemetry(telemetry)
    await pool.end()
    await database.drop()
  })

  test('is written within seconds, with its account, the request and where it ran', async () => {
    const { telemetry } = serveMetrics(undefined, ['api'], { pool, boss: {} as PgBoss, url: database.url })
    const db = createDb(pool)
    installTelemetry(telemetry, { db, roles: ['api'] })
    let refused: { code?: string; message?: string } = {}
    await within({ origin: 'trpc:servers.get', accountId: 'acct-1', requestId: 'req-1' }, async () => {
      await db.execute(sql`select pg_sleep(0.3)`)
      await db.execute(sql`select 1 / 0`).catch((error: Error & { cause?: typeof refused }) => {
        refused = error.cause ?? error
      })
      // A value Postgres quotes back in what it refused with.
      await db.execute(sql`select ${'private-not-a-uuid'}::uuid`).catch(() => undefined)
      requestServed('api', '/api/trpc/*', 'POST', 503, 12)
    })
    let rows: Array<typeof schema.diagnostics.$inferSelect> = []
    for (let waited = 0; rows.length < 4 && waited < 10 * SECOND_MS; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      rows = await db.select().from(schema.diagnostics)
    }
    expect(rows.map((row) => [row.kind, row.accountId, row.requestId, row.origin, row.role]).sort()).toEqual([
      ['query', 'acct-1', 'req-1', 'trpc:servers.get', 'api'],
      ['query', 'acct-1', 'req-1', 'trpc:servers.get', 'api'],
      ['query', 'acct-1', 'req-1', 'trpc:servers.get', 'api'],
      ['request', 'acct-1', 'req-1', 'trpc:servers.get', 'api'],
    ])
    // What Postgres said of the value, without the value.
    const typed = rows.find((row) => JSON.stringify(row.detail).includes('uuid'))
    expect(JSON.stringify(typed?.detail)).not.toContain('private-not-a-uuid')
    expect(typed?.detail).toMatchObject({ message: 'invalid input syntax for type uuid: "?"' })
    // What Postgres refused with, as it said it.
    const failed = rows.find(
      (row) => row.kind === 'query' && row.error !== null && row.detail.statement === 'select ? / ?',
    )
    expect(failed?.error).toBe(refused.code as string)
    expect(failed?.detail).toMatchObject({ statement: 'select ? / ?', message: refused.message })
    const query = rows.find((row) => row.kind === 'query' && row.error === null)
    expect(query?.ms).toBeGreaterThanOrEqual(300)
    expect(query?.detail).toMatchObject({ operation: 'SELECT', statement: 'select pg_sleep(?)' })
    expect(rows.find((row) => row.kind === 'request')).toMatchObject({
      name: 'POST /api/trpc/*',
      error: '503',
    })
  }, 20_000)
})
