// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How each Paper server ticked, one row a minute as its reporter plugin sampled it
 * (`app/vitals/`): ticks a second, milliseconds a tick, players, chunks, entities, heap and
 * garbage collection. Kept 7 days. Not for a join's own tick, which its `joins` row keeps.
 */
import { bigserial, index, integer, pgTable, real, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
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
    tps: real('tps').notNull(),
    mspt: real('mspt').notNull(),
    msptP95: real('mspt_p95').notNull(),
    msptMax: real('mspt_max').notNull(),
    players: integer('players').notNull(),
    chunks: integer('chunks').notNull(),
    entities: integer('entities').notNull(),
    heapUsedMb: integer('heap_used_mb').notNull(),
    heapMaxMb: integer('heap_max_mb').notNull(),
    gcMs: integer('gc_ms').notNull(),
  },
  (t) => [
    // A sample sent twice, as a retry may, is kept once.
    uniqueIndex('server_vitals_once').on(t.serverId, t.at),
    index('server_vitals_at').on(t.at),
  ],
)
