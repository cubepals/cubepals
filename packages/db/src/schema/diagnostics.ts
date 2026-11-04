// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What ran slow or failed in the control plane, with whose it was: one row per slow or failed
 * query, tRPC procedure or HTTP request, with the account, server and request it ran for where
 * they are known (`app/diagnostics/`). Kept 14 days. Not for counts or percentiles across the
 * platform, which the metrics hold without naming anyone (`docs/metrics.md`).
 */
import { sql } from 'drizzle-orm'
import { bigserial, index, jsonb, pgTable, real, text, uuid } from 'drizzle-orm/pg-core'
import { ts } from './columns.ts'

export const diagnostics = pgTable(
  'diagnostics',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull(),
    /** `query`, `procedure` or `request`. */
    kind: text('kind').notNull(),
    /** What it was: a query's shape (`q:` and 12 hex), a procedure's path, a request's route template. */
    name: text('name').notNull(),
    ms: real('ms').notNull(),
    /** Null when it succeeded; a query's SQLSTATE, or a request's or procedure's HTTP status. */
    error: text('error'),
    /** What it ran under: `trpc:<path>`, `http:<listener> <route>`, `job:<queue>`, `schedule:<job>`. */
    origin: text('origin').notNull(),
    /** The process's roles, as the metrics name them (`api`, `worker`, `api+worker+realtime`). */
    role: text('role').notNull(),
    accountId: text('account_id'),
    serverId: uuid('server_id'),
    requestId: text('request_id'),
    /** A query's statement and opening word, an error's message, an operation's kind. */
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('diagnostics_at').on(t.at),
    index('diagnostics_account').on(t.accountId, t.at).where(sql`${t.accountId} is not null`),
    index('diagnostics_server').on(t.serverId, t.at).where(sql`${t.serverId} is not null`),
    index('diagnostics_name').on(t.kind, t.name, t.at),
  ],
)
