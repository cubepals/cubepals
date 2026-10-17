// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The release command (`node packages/db/src/migrate.ts`, infra/fly/control.toml) runs while the
 * previous release keeps serving. A migration that has to wait for a lock (behind the nightly
 * pg_dump's ACCESS SHARE, or any long transaction) gives way after a short wait, so the queries
 * the running control plane makes on that table never queue behind it. Shown with the newest
 * migration (an ALTER TABLE) made pending again on a migrated database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { createDb, createPool, migrationsFolder } from './index.ts'

const base = process.env.DATABASE_URL
const MIGRATE = fileURLToPath(new URL('./migrate.ts', import.meta.url))

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
    // 0083 pending again, as the next release's migration would be.
    await pool.query('ALTER TABLE "fleet_placements" DROP COLUMN "sent_digest"')
    await pool.query(
      'DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)',
    )
    await pool.end()
  }, 60_000)
  afterAll(async () => {
    const cleanup = new pg.Client({ connectionString: base })
    await cleanup.connect()
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await cleanup.end()
  })

  test('gives way rather than stall the running release', async () => {
    // The nightly dump, or any long transaction that has read the table.
    const holder = new pg.Client({ connectionString: url })
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query('SELECT count(*) FROM "fleet_placements"')

    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url }
    delete env.DATABASE_DIRECT_URL
    const release = spawn('bun', [MIGRATE], { env, stdio: 'ignore' })
    const releaseEnded = new Promise<number>((resolve) => release.on('exit', (code) => resolve(code ?? -1)))
    await Bun.sleep(1_000)

    // The previous release's control plane, reading the table as it serves.
    const reader = new pg.Client({ connectionString: url })
    await reader.connect()
    await reader.query("SET statement_timeout = '10s'")
    const read = await reader.query('SELECT 1 FROM "fleet_placements" LIMIT 1').then(
      () => 'answered',
      (error: Error) => error.message,
    )

    await holder.query('COMMIT')
    await holder.end()
    await reader.end()
    expect(read).toBe('answered')
    // Once the holder is done, a later try applies the migration.
    expect(await releaseEnded).toBe(0)
  }, 60_000)
})
