// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { createPool } from '@blockly/db'
import pg from 'pg'

// Needs a real Postgres: DATABASE_URL=postgres://… bun test
const url = process.env.DATABASE_URL

describe.skipIf(!url)('the connection pool', () => {
  test('a connection the server cuts while it sits idle is replaced, and the process carries on', async () => {
    const pool = createPool(url ?? '')
    // Node ends a process on an `error` nobody hears; Bun, which runs these tests, doesn't, so
    // the listener itself is what is checked.
    expect(pool.listenerCount('error')).toBe(1)
    const { rows } = await pool.query<{ pid: number }>('select pg_backend_pid() as pid')
    // What a pooler restart or a failover does to a client resting in the pool.
    const admin = new pg.Client({ connectionString: url })
    await admin.connect()
    await admin.query('select pg_terminate_backend($1)', [rows[0]?.pid])
    await admin.end()
    await Bun.sleep(200)
    expect((await pool.query<{ one: number }>('select 1 as one')).rows[0]).toEqual({ one: 1 })
    await pool.end()
  })
})
