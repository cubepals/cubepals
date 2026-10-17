// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The release command: brings the database up to this release's schema while the previous
 * release keeps serving. A migration that has to wait for a lock (behind the nightly dump, or any
 * long transaction) gives way after a short wait, because every later query on that table would
 * queue behind it and stall the running control plane. It tries again a few times, waiting longer
 * each time, and then fails the release with a plain message: Fly keeps the old release serving.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { LOCK_NOT_AVAILABLE, MIGRATION_LOCK_WAIT_MS, migrationsFolder } from './index.ts'

/**
 * How many times the migrations try, and the wait before the second; each wait doubles. Tests
 * shorten the wait (MIGRATION_BACKOFF_MS) so a run that gives up ends in seconds.
 */
const ATTEMPTS = 5
const FIRST_BACKOFF_MS = Number(process.env.MIGRATION_BACKOFF_MS) || 5 * SECOND_MS
/** The migrations to apply: this package's, or, in tests, a copy holding one of their own. */
const folder = process.env.MIGRATIONS_FOLDER || migrationsFolder

// Migrations take advisory locks and run DDL, which belong on a connection of their own: past a
// pooler when there is one (DATABASE_DIRECT_URL), else the one URL there is.
const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

/** Whether an error, or the one a query error wraps, is a lock wait that ran out. */
const gaveWay = (error: unknown): boolean =>
  (error as { code?: string }).code === LOCK_NOT_AVAILABLE ||
  (error as { cause?: { code?: string } }).cause?.code === LOCK_NOT_AVAILABLE

// One connection, so the lock timeout set on it covers every statement the migrations send.
const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  // SET takes no bind parameters.
  await client.query(`SET lock_timeout = ${MIGRATION_LOCK_WAIT_MS}`)
  for (let attempt = 1; ; attempt++) {
    try {
      // All pending migrations run in one transaction, so one that gives way leaves none applied.
      await migrate(drizzle(client), { migrationsFolder: folder })
      break
    } catch (error) {
      if (!gaveWay(error)) throw error
      if (attempt === ATTEMPTS) {
        console.error(
          `The migrations waited for a table another session holds, ${ATTEMPTS} times, and gave way each time ` +
            'so the running release keeps serving. Nothing was changed. Deploy again once that session ends ' +
            '(a long transaction, or the nightly database dump).',
        )
        process.exitCode = 1
        break
      }
      const backoffMs = FIRST_BACKOFF_MS * 2 ** (attempt - 1)
      console.error(`A table the migrations change is busy; trying again in ${backoffMs / SECOND_MS} s.`)
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }
} finally {
  await client.end()
}
