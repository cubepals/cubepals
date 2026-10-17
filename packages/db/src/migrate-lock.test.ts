// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The release command (`node packages/db/src/migrate.ts`, infra/fly/control.toml) runs while the
 * previous release keeps serving. A migration that has to wait for a lock (behind the nightly
 * pg_dump's ACCESS SHARE, or any long transaction) gives way after a short wait, so the queries
 * the running control plane makes on that table never queue behind it. Shown with the newest
 * migration (an ALTER TABLE) made pending again on a migrated database. When the lock never
 * frees, the release fails after its last try and changes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { createDb, createPool, MIGRATION_LOCK_WAIT_MS, migrationsFolder } from './index.ts'

const base = process.env.DATABASE_URL
const MIGRATE = fileURLToPath(new URL('./migrate.ts', import.meta.url))

/** The newest migration (0083, an ALTER TABLE) pending again, as the next release's would be. */
async function makePending(pool: pg.Pool): Promise<void> {
  await pool.query('ALTER TABLE "fleet_placements" DROP COLUMN "sent_digest"')
  await pool.query(
    'DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)',
  )
}

/** A long transaction that has read the table: the nightly dump, or any other. */
async function holdTable(url: string): Promise<pg.Client> {
  const holder = new pg.Client({ connectionString: url })
  await holder.connect()
  await holder.query('BEGIN')
  await holder.query('SELECT count(*) FROM "fleet_placements"')
  return holder
}

/** The release command, run as Fly runs it, on this database alone. */
function release(url: string, extra: NodeJS.ProcessEnv = {}): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, ...extra }
  delete env.DATABASE_DIRECT_URL
  const child = spawn('bun', [MIGRATE], { env, stdio: 'ignore' })
  return new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)))
}

describe.skipIf(!base)('a migration waiting for a lock during a deploy', () => {
  const name = `blockly_test_${randomBytes(5).toString('hex')}`
  let url: string
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
    const u = new URL(base as string)
    u.pathname = `/${name}`
    url = u.toString()
    const pool = createPool(url)
    await migrate(createDb(pool), { migrationsFolder })
    await makePending(pool)
    await pool.end()
  }, 60_000)
  afterAll(async () => {
    const cleanup = new pg.Client({ connectionString: base })
    await cleanup.connect()
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await cleanup.end()
  })

  test('gives way rather than stall the running release', async () => {
    const holder = await holdTable(url)
    const releaseEnded = release(url)
    await Bun.sleep(1_000)

    // The previous release's control plane, reading the table as it serves.
    const reader = new pg.Client({ connectionString: url })
    await reader.connect()
    await reader.query("SET statement_timeout = '10s'")
    const started = Date.now()
    const read = await reader.query('SELECT 1 FROM "fleet_placements" LIMIT 1').then(
      () => 'answered',
      (error: Error) => error.message,
    )
    const queuedMs = Date.now() - started

    await holder.query('COMMIT')
    await holder.end()
    await reader.end()
    expect(read).toBe('answered')
    // It queued only while the migration waited, never past the migration's lock timeout.
    expect(queuedMs).toBeLessThan(MIGRATION_LOCK_WAIT_MS)
    // Once the holder is done, a later try applies the migration.
    expect(await releaseEnded).toBe(0)
  }, 60_000)

  test('fails the release after the last try, changing nothing, when the lock never frees', async () => {
    const pool = createPool(url)
    await makePending(pool)
    const holder = await holdTable(url)
    // Every try waits out the lock timeout; the waits between tries are cut short.
    const code = await release(url, { MIGRATION_BACKOFF_MS: '100' })
    await holder.query('COMMIT')
    await holder.end()
    const { rowCount } = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'fleet_placements' AND column_name = 'sent_digest'",
    )
    await pool.end()
    expect(code).toBe(1)
    expect(rowCount).toBe(0)
  }, 60_000)
})
