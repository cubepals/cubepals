// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createDb, createPool, migrationsFolder } from './index.ts'

// Migrations take advisory locks and run DDL, which belong on a connection of their own: past a
// pooler when there is one (DATABASE_DIRECT_URL), else the one URL there is.
const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const pool = createPool(url)
try {
  await migrate(createDb(pool), { migrationsFolder })
} finally {
  await pool.end()
}
