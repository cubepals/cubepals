// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Queries heard from the query pool on a real database, under a pool of one connection that every
 * query but the first waits for: each told in the work that asked for it, failures included.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, createPool } from '@blockly/db'
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { currentWork, within } from '../../app/diagnostics/context.ts'
import { hearQueries } from './pools.ts'

const url = process.env.DATABASE_URL

describe.skipIf(!url)('queries heard from the pool', () => {
  let pool: Pool
  const heard: Array<{ statement: unknown; failed: boolean; whose: string | undefined }> = []

  beforeAll(() => {
    // One connection, so every query but the first waits for the one before to give it back.
    pool = createPool(url as string, 1)
    hearQueries(pool).push((statement, _ms, error) =>
      heard.push({ statement, failed: error !== null, whose: currentWork()?.accountId }),
    )
  })
  afterAll(() => pool.end())

  test('are each told in the work that asked, not the one that gave back the connection', async () => {
    const db = createDb(pool)
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((account) =>
        // Drizzle's queries run once awaited, so each is awaited inside its work, as the code does.
        within({ accountId: account }, async () => {
          await db.execute(sql.raw(`select pg_sleep(0.05), '${account}' as who`))
        }),
      ),
    )
    // A transaction's queries run on a client it took, as promises.
    await within({ accountId: 't' }, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select 1`)
      }),
    )
    const said = heard
      .filter(({ statement }) => typeof statement === 'string' && statement.includes('as who'))
      .map(({ statement, whose }) => [/'(\w)' as who/.exec(statement as string)?.[1], whose])
    expect(said).toEqual([
      ['a', 'a'],
      ['b', 'b'],
      ['c', 'c'],
      ['d', 'd'],
    ])
    expect(heard.filter(({ whose }) => whose === 't').length).toBeGreaterThanOrEqual(3)
  })

  test('say what a query failed with', async () => {
    const db = createDb(pool)
    await within({ accountId: 'x' }, async () => {
      await db.execute(sql`select 1/0`)
    }).catch(() => undefined)
    expect(heard.at(-1)).toMatchObject({ failed: true, whose: 'x' })
  })
})
