// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Persisted import progress must round-trip through the actual migrated database, including old null rows. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { WorldImportProgress } from '@blockly/contracts'
import { inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type pg from 'pg'
import { createDb, createPool, migrationsFolder } from '../index.ts'
import { worldImports } from './artifacts.ts'
import { users } from './auth.ts'

const base = process.env.DATABASE_URL

describe.skipIf(!base)('world import progress in the release schema', () => {
  const name = `blockly_test_${randomUUID().replaceAll('-', '')}`
  let pool: pg.Pool
  let db: ReturnType<typeof createDb>
  beforeAll(async () => {
    const admin = createPool(base as string, 1)
    try {
      await admin.query(`CREATE DATABASE ${name}`)
    } finally {
      await admin.end()
    }
    const url = new URL(base as string)
    url.pathname = `/${name}`
    pool = createPool(url.toString(), 1)
    db = createDb(pool)
    await migrate(db, { migrationsFolder })
  }, 30_000)
  afterAll(async () => {
    await pool?.end()
    const admin = createPool(base as string, 1)
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    } finally {
      await admin.end()
    }
  })

  test('new progress survives a write and read while earlier imports remain null', async () => {
    const ownerId = randomUUID()
    await db.insert(users).values({ id: ownerId, name: 'Schema test', email: `${ownerId}@example.com` })
    const id = randomUUID()
    const legacyId = randomUUID()
    const at = new Date().toISOString()
    const progress: WorldImportProgress = {
      step: 'fetching',
      startedAt: at,
      updatedAt: at,
      bytes: 5,
      totalBytes: 10,
      steps: [{ step: 'fetching', at }],
    }
    await db.insert(worldImports).values([
      { id, ownerId, fileName: 'Life.tar', sizeBytes: 10, progress },
      { id: legacyId, ownerId, fileName: 'Earlier.tar', sizeBytes: 10 },
    ])
    const rows = await db
      .select({ id: worldImports.id, progress: worldImports.progress })
      .from(worldImports)
      .where(inArray(worldImports.id, [id, legacyId]))
    expect(rows.find((row) => row.id === id)?.progress).toEqual(progress)
    expect(rows.find((row) => row.id === legacyId)?.progress).toBeNull()
  })
})
