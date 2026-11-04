// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How each server ticked, one row a minute (`app/vitals/`): as its reporter plugin sampled it on a
 * Paper server (`source` `reporter`: ticks a second, milliseconds a tick, players, chunks,
 * entities, heap and garbage collection), or as the control plane read it over the server's
 * console with `tick query` on any other (`console`: ticks a second, milliseconds a tick and
 * players; what only the plugin sees is null). Kept 7 days. Not for a join's own tick, which its
 * `joins` row keeps.
 */
import { sql } from 'drizzle-orm'
import { bigserial, check, index, integer, pgTable, real, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { ts } from './columns.ts'
import { minecraftServers } from './servers.ts'

export const serverVitals = pgTable(
  'server_vitals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id, { onDelete: 'cascade' }),
    at: ts('at').notNull(),
    source: text('source').notNull().default('reporter'),
    tps: real('tps').notNull(),
    mspt: real('mspt').notNull(),
    msptP95: real('mspt_p95').notNull(),
    msptMax: real('mspt_max').notNull(),
    players: integer('players').notNull(),
    chunks: integer('chunks'),
    entities: integer('entities'),
    heapUsedMb: integer('heap_used_mb'),
    heapMaxMb: integer('heap_max_mb'),
    gcMs: integer('gc_ms'),
  },
  (t) => [
    // A sample sent twice, as a retry may, is kept once.
    uniqueIndex('server_vitals_once').on(t.serverId, t.at),
    index('server_vitals_at').on(t.at),
    check('server_vitals_source', sql`${t.source} in ('reporter', 'console')`),
  ],
)
