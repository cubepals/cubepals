// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The one-time migration preserves existing idle-kick choices, including never, without a new default. */
import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'

const base = process.env.DATABASE_URL

test.skipIf(!base)('idle-kick choices are copied to each existing server once', async () => {
  const client = new pg.Client({ connectionString: base })
  await client.connect()
  try {
    await client.query('BEGIN')
    const name = `afk_migration_${randomBytes(5).toString('hex')}`
    await client.query(`CREATE SCHEMA ${name}`)
    await client.query(`SET LOCAL search_path TO ${name}`)
    await client.query('CREATE TABLE account_standing (user_id text PRIMARY KEY, afk_kick_minutes integer)')
    await client.query('CREATE TABLE minecraft_servers (id text PRIMARY KEY, owner_id text NOT NULL)')
    await client.query("INSERT INTO account_standing VALUES ('never', 0), ('custom', 45), ('default', NULL)")
    await client.query("INSERT INTO minecraft_servers VALUES ('one', 'never'), ('two', 'never'), ('three', 'custom'), ('four', 'default'), ('five', 'missing')")
    const migration = readFileSync(new URL('../migrations/0109_server_afk_kick.sql', import.meta.url), 'utf8')
    await client.query(migration)
    const { rows } = await client.query('SELECT id, afk_kick_minutes FROM minecraft_servers ORDER BY id')
    expect(rows).toEqual([
      { id: 'five', afk_kick_minutes: null },
      { id: 'four', afk_kick_minutes: null },
      { id: 'one', afk_kick_minutes: 0 },
      { id: 'three', afk_kick_minutes: 45 },
      { id: 'two', afk_kick_minutes: 0 },
    ])
    await client.query("INSERT INTO minecraft_servers VALUES ('new', 'never')")
    const added = await client.query("SELECT afk_kick_minutes FROM minecraft_servers WHERE id = 'new'")
    expect(added.rows[0]).toEqual({ afk_kick_minutes: null })
  } finally {
    await client.query('ROLLBACK')
    await client.end()
  }
})
