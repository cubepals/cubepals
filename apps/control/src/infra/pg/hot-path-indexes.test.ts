// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The queries that run every second or every minute, whatever the number of servers, find their
 * rows through an index rather than reading the whole table. Each real query is caught as it runs
 * and planned again with sequential scans priced out, so the plan names an index exactly when one
 * fits the query's own shape.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { liftedIpBans } from '../../app/access/persistence.ts'
import { mainPlayerPairs } from '../../app/accounts/free-links.ts'
import { countServers } from '../../app/accounts/persistence.ts'
import { pastExpiry } from '../../app/backups/persistence.ts'
import { latestOfKind } from '../../app/operations/persistence.ts'
import { heldByDeleted, listByStatus } from '../../app/servers/persistence.ts'
import { freshDatabase, hasDatabase } from '../../testing/fleet.ts'

describe.skipIf(!hasDatabase)('hot path indexes', () => {
  let drop: () => Promise<void>
  let pool: pg.Pool
  let caught: { query: string; params: unknown[] }[] = []
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeAll(async () => {
    const fresh = await freshDatabase()
    drop = fresh.drop
    pool = new pg.Pool({ connectionString: fresh.url, max: 1 })
    db = drizzle(pool, {
      schema,
      logger: { logQuery: (query, params) => caught.push({ query, params }) },
    })
  })

  afterAll(async () => {
    await pool.end()
    await drop()
  })

  /** The plan of the first query `run` makes, with sequential scans as dear as they go. */
  async function planOf(run: () => Promise<unknown>): Promise<string> {
    caught = []
    await run()
    const first = caught[0]
    if (first === undefined) throw new Error('the call made no query')
    const client = await pool.connect()
    try {
      await client.query('SET enable_seqscan = off')
      const plan = await client.query(`EXPLAIN ${first.query}`, first.params)
      return plan.rows.map((row: { 'QUERY PLAN': string }) => row['QUERY PLAN']).join('\n')
    } finally {
      await client.query('RESET enable_seqscan')
      client.release()
    }
  }

  test('every running server, read by each minute’s sweeps', async () => {
    expect(await planOf(() => listByStatus(db, 'running'))).toContain('servers_status')
  })

  test('the platform’s servers and running ones, counted by every create, start and undelete', async () => {
    expect(await planOf(() => countServers(db))).toContain('servers_live_status')
  })

  test('whether a server in the trash holds an address, asked by wakes for unknown ones', async () => {
    expect(await planOf(() => heldByDeleted(db, 'nobody-here'))).toContain('servers_slug_deleted')
  })

  test('a server’s newest operation of one kind, read for each server on a list', async () => {
    expect(await planOf(() => latestOfKind(db, randomUUID(), 'start'))).toContain('operations_server_kind')
  })

  test('ready backups past their expiry, swept every hour', async () => {
    expect(await planOf(() => pastExpiry(db, new Date()))).toContain('backups_ready_expiry')
  })

  test('the servers someone was seen on in the last day, read by free-play links', async () => {
    expect(await planOf(() => mainPlayerPairs(db, new Date()))).toContain('server_players_confirmed')
  })

  test('IP bans lifted on a server, read by its access page', async () => {
    expect(await planOf(() => liftedIpBans(db, randomUUID(), new Date(0)))).toContain('audit_log_subject')
  })
})
