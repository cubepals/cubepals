// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The release command (`node packages/db/src/migrate.ts`, infra/fly/control.toml) runs while the
 * previous release keeps serving. A migration that has to wait for a lock (behind the nightly
 * pg_dump's ACCESS SHARE, or any long transaction) gives way after a short wait, so the queries
 * the running control plane makes on that table never queue behind it. Shown on a migrated
 * database with one more migration of the test's own (an ALTER TABLE on the table it holds),
 * after every real one, so it stays true however many migrations come later. When the lock never
 * frees, the release fails after its last try and changes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { createDb, createPool, MIGRATION_LOCK_WAIT_MS, migrationsFolder } from './index.ts'

const base = process.env.DATABASE_URL
const MIGRATE = fileURLToPath(new URL('./migrate.ts', import.meta.url))

/** The table the tests hold, and their own migration alters. */
const TABLE = 'fleet_placements'

const folders: string[] = []

/**
 * Every real migration, copied, and one more after them all, as the next release's would be: it
 * adds `column` to TABLE. Returns the copy's folder, for the release's MIGRATIONS_FOLDER.
 */
function withPending(column: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'migrate-lock-'))
  folders.push(folder)
  cpSync(migrationsFolder, folder, { recursive: true })
  const journalPath = join(folder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
  }
  const last = journal.entries.reduce((a, b) => (b.when > a.when ? b : a))
  const tag = `9999_${column}`
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + folders.length, tag })
  writeFileSync(journalPath, JSON.stringify(journal))
  writeFileSync(join(folder, `${tag}.sql`), `ALTER TABLE "${TABLE}" ADD COLUMN "${column}" text;`)
  return folder
}

/** Whether TABLE has `column`, which only the test's own migration adds. */
async function hasColumn(url: string, column: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  const { rowCount } = await client.query(
    'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
    [TABLE, column],
  )
  await client.end()
  return rowCount === 1
}

/** A long transaction that has read the table: the nightly dump, or any other. */
async function holdTable(url: string): Promise<pg.Client> {
  const holder = new pg.Client({ connectionString: url })
  await holder.connect()
  await holder.query('BEGIN')
  await holder.query(`SELECT count(*) FROM "${TABLE}"`)
  return holder
}

/** The release command, run as Fly runs it, on this database alone, with `folder`'s migrations. */
function release(url: string, folder: string, extra: NodeJS.ProcessEnv = {}): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, MIGRATIONS_FOLDER: folder, ...extra }
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
    await pool.end()
  }, 60_000)
  afterAll(async () => {
    const cleanup = new pg.Client({ connectionString: base })
    await cleanup.connect()
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await cleanup.end()
    for (const folder of folders) rmSync(folder, { recursive: true, force: true })
  })

  test('gives way rather than stall the running release', async () => {
    const folder = withPending('lock_test_gives_way')
    const holder = await holdTable(url)
    const releaseEnded = release(url, folder)
    await Bun.sleep(1_000)

    // The previous release's control plane, reading the table as it serves.
    const reader = new pg.Client({ connectionString: url })
    await reader.connect()
    await reader.query("SET statement_timeout = '10s'")
    const started = Date.now()
    const read = await reader.query(`SELECT 1 FROM "${TABLE}" LIMIT 1`).then(
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
    expect(await hasColumn(url, 'lock_test_gives_way')).toBe(true)
  }, 60_000)

  test('fails the release after the last try, changing nothing, when the lock never frees', async () => {
    const folder = withPending('lock_test_never_frees')
    const holder = await holdTable(url)
    // Every try waits out the lock timeout; the waits between tries are cut short.
    const code = await release(url, folder, { MIGRATION_BACKOFF_MS: '100' })
    await holder.query('COMMIT')
    await holder.end()
    expect(code).toBe(1)
    expect(await hasColumn(url, 'lock_test_never_frees')).toBe(false)
  }, 60_000)
})
