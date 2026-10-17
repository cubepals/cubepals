// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How long the control plane holds the tables the migrations change, measured: a server is
 * created, started, stopped, restarted and backed up through the real application while a second
 * connection samples Postgres every few milliseconds for the oldest open transaction holding any
 * lock on one of those tables. A migration that gives way after MIGRATION_LOCK_WAIT_MS must not
 * give way to the control plane's own work, so that work holds them for far less.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATION_LOCK_WAIT_MS, migrationsFolder } from '@blockly/db'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

/** Every table a migration has altered: those a later migration is likely to alter again. */
const altered = [
  ...new Set(
    readdirSync(migrationsFolder)
      .filter((file) => file.endsWith('.sql'))
      .flatMap((file) =>
        [...readFileSync(join(migrationsFolder, file), 'utf8').matchAll(/ALTER TABLE "([a-z_]+)"/g)].map(
          (match) => match[1] as string,
        ),
      ),
  ),
]

describe.skipIf(!hasDatabase)('the tables the migrations change', () => {
  let h: Harness
  let sampler: pg.Client

  beforeAll(async () => {
    h = await startHarness()
    const { rows } = await h.db.execute<{ name: string }>(sql`SELECT current_database() AS name`)
    const url = new URL(process.env.DATABASE_URL as string)
    url.pathname = `/${rows[0]?.name}`
    sampler = new pg.Client({ connectionString: url.toString() })
    await sampler.connect()
  }, 30_000)

  afterAll(async () => {
    await sampler.end()
    await h.close()
  })

  test('are held by the control plane for far less than a migration waits for them', async () => {
    const tables = (
      await sampler.query<{ name: string }>(
        'SELECT relname AS name FROM pg_class WHERE relkind = $1 AND relname = ANY($2)',
        ['r', altered],
      )
    ).rows.map((row) => row.name)
    let longestMs = 0
    let sampling = true
    const sampled = (async () => {
      while (sampling) {
        const { rows } = await sampler.query<{ ms: number | null }>(
          `SELECT max(extract(epoch FROM clock_timestamp() - a.xact_start) * 1000)::float AS ms
             FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'relation' AND a.pid <> pg_backend_pid()
              AND l.relation IN (SELECT oid FROM pg_class WHERE relname = ANY($1))`,
          [tables],
        )
        longestMs = Math.max(longestMs, rows[0]?.ms ?? 0)
      }
    })()

    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, crypto.randomUUID())
    await h.settled(id)
    await h.app.servers.start(owner, id, crypto.randomUUID())
    await h.settled(id)
    await h.app.servers.restart(owner, id, crypto.randomUUID())
    await h.settled(id)
    await h.app.backups.createBackup(owner, id, crypto.randomUUID())
    await h.settled(id)
    sampling = false
    await sampled

    expect(tables.length).toBeGreaterThan(0)
    expect(longestMs).toBeLessThan(MIGRATION_LOCK_WAIT_MS / 10)
  }, 60_000)
})
