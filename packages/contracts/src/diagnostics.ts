// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What ran slow or failed in the control plane and whose it was, and the database as it is now,
 * as operators read them under `/ops/v1/diagnostics`, `/ops/v1/database` and
 * `/ops/v1/accounts/<account>/diagnosis` (`bun scripts/ops.ts diagnostics`, the ops MCP's
 * `diagnostics_*`, `database_now` and `account_diagnose`).
 *
 * Not for the platform's counts and percentiles, which name no one (`docs/metrics.md`).
 */
import { z } from 'zod'
import type { HealthOperationView } from './health.ts'
import type { JoinView, SignalView } from './join-records.ts'
import type { VitalsRowView } from './server-vitals.ts'

export const DIAGNOSTIC_KINDS = ['query', 'procedure', 'request'] as const
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number]

/** What a summary groups by: what it was, whose, which server, or what it ran under. */
export const DIAGNOSTIC_GROUPS = ['name', 'account', 'server', 'origin', 'kind'] as const

const Moment = z.iso.datetime({ offset: true })

/** Which records: narrowed by whose, which server, what and when. `account` is an id or an email. */
export const DiagnosticsQuery = z.object({
  account: z.string().min(1).max(320).optional(),
  server: z.uuid().optional(),
  kind: z.enum(DIAGNOSTIC_KINDS).optional(),
  /** A query's shape (`q:…`), a procedure's path or a route template, exactly. */
  name: z.string().min(1).max(200).optional(),
  /** What it ran under, from its start: `trpc:servers`, `job:`, `schedule:reconcile`. */
  origin: z.string().min(1).max(200).optional(),
  /** Only failed ones (`true`), or only slow ones that didn't fail (`false`). */
  failed: z.enum(['true', 'false']).optional(),
  /** At or after; a day ago unless given. */
  since: Moment.optional(),
  until: Moment.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
export type DiagnosticsQuery = z.infer<typeof DiagnosticsQuery>

export const DiagnosticsSummaryQuery = DiagnosticsQuery.omit({ limit: true }).extend({
  by: z.enum(DIAGNOSTIC_GROUPS).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type DiagnosticsSummaryQuery = z.infer<typeof DiagnosticsSummaryQuery>

/** One slow or failed thing, with whose it was. */
export interface DiagnosticView {
  id: number
  at: string
  kind: DiagnosticKind
  /** A query's shape (`q:` and 12 hex), a procedure's path, a request's route template. */
  name: string
  ms: number
  /** Null when it was only slow; a query's SQLSTATE, or the HTTP status a 5xx answered with. */
  error: string | null
  origin: string
  role: string
  accountId: string | null
  accountEmail: string | null
  serverId: string | null
  serverName: string | null
  requestId: string | null
  /** A query's `statement` and `operation`, an error's `message`, an HTTP `status`. */
  detail: Record<string, unknown>
}

/** Records grouped: how many, how many failed, how slow, whom they touched, and one to look at. */
export interface DiagnosticGroupView {
  /** What they share: a name, an account id, a server id, an origin or a kind. */
  key: string
  /** For an account or a server, its email or name. */
  label: string | null
  count: number
  failed: number
  accounts: number
  servers: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  firstAt: string
  lastAt: string
  /** The slowest of them, to read in full. */
  slowest: DiagnosticView
}

export interface DiagnosticsSummaryView {
  since: string
  until: string
  by: (typeof DIAGNOSTIC_GROUPS)[number]
  total: number
  failed: number
  /** The groups with the most records first. */
  groups: DiagnosticGroupView[]
  /** What each kind counts as slow, in milliseconds. */
  thresholds: { queryMs: number; procedureMs: number; requestMs: number }
}

/** A statement as `pg_stat_statements` has counted it since its statistics were last reset. */
export interface StatementView {
  queryId: string
  /** The role that ran it: the control plane's own, or another's (a pooler, a dashboard). */
  role: string
  calls: number
  totalMs: number
  meanMs: number
  maxMs: number
  rows: number
  /** Share of its reads served from Postgres's memory; null with none. */
  cacheHit: number | null
  query: string
}

/** A query running now, or waiting on another's lock. */
export interface ActivityView {
  pid: number
  application: string
  state: string
  /** What it waits on (`Lock`, `IO`, `Client`), or null. */
  wait: string | null
  /** Seconds since this query began, and since its transaction did. */
  querySeconds: number
  transactionSeconds: number | null
  /** The pids holding the locks it waits on. */
  blockedBy: number[]
  query: string
}

/** A table as Postgres counts its reads and writes. */
export interface TableView {
  name: string
  sizeBytes: number
  rows: number
  deadRows: number
  seqScans: number
  /** Rows read by sequential scans: high on a big table means a missing index. */
  seqRows: number
  indexScans: number
  lastAutovacuum: string | null
}

export interface DatabaseView {
  at: string
  connections: Array<{ application: string; state: string; count: number }>
  max: number
  /** Queries running for more than a second, or waiting on a lock, the longest first. */
  active: ActivityView[]
  /**
   * The statements that took the most time in all, where `pg_stat_statements` is installed;
   * otherwise why not.
   */
  statements:
    | { available: true; since: string | null; top: StatementView[] }
    | { available: false; why: string }
  /** The tables sequential scans read the most rows from. */
  tables: TableView[]
}

/** The order `/ops/v1/database` lists statements in. */
export const STATEMENT_ORDERS = ['total', 'mean', 'calls', 'max'] as const
export const DatabaseQuery = z.object({
  order: z.enum(STATEMENT_ORDERS).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
export type DatabaseQuery = z.infer<typeof DatabaseQuery>

/**
 * Everything known about why one account is having a bad time, in one answer: who it is, its
 * servers, the operations that failed or were slow, joins that didn't reach the world, open
 * signals, how its Paper servers ticked, and what ran slow or failed in the control plane for it,
 * grouped and newest.
 */
export interface AccountDiagnosisView {
  account: { id: string; email: string; name: string; plan: string; status: string; test: boolean }
  /**
   * An operator's notice on the account (`ops.ts notice`), which its servers show players, and when
   * it limits the account and did; null while there is none.
   */
  notice: {
    text: string
    setAt: string
    setBy: string
    limitAt: string | null
    limitedAt: string | null
  } | null
  since: string
  servers: Array<{ id: string; name: string; slug: string; status: string; deleted: boolean }>
  operations: { failed: HealthOperationView[]; slowest: HealthOperationView[] }
  /**
   * Joins known to have stopped before the world, or refused, newest first. One handed to a server
   * with no reporter that ended before its player list was read is in neither this nor the world.
   */
  joins: JoinView[]
  signals: SignalView[]
  diagnostics: { summary: DiagnosticGroupView[]; recent: DiagnosticView[] }
  /** How its Paper servers ticked, the most minutes behind first: those its reporter runs on. */
  vitals: VitalsRowView[]
  /** Where else to look, as sentences: what the record can't say. */
  elsewhere: string[]
}
