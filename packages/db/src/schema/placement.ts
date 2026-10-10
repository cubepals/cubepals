// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where servers run when a deployment has several runtimes (docs/runtimes.md): an operator's
 * placement rules, and each decision made under them.
 */
import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import type { RuntimeConsideredJson } from '../json.ts'
import { createdAt, ts, updatedAt } from './columns.ts'
import { minecraftServers } from './servers.ts'

// ─── Runtime placement ──────────────────────────────────────────────────────────────────────

/**
 * Where new servers go besides the deployment's default runtime (docs/runtimes.md): an operator's
 * rule sending a share of matching new servers to one runtime. Rules are read in the order they
 * were made; the first that matches, on a runtime with room, places the server. Existing servers
 * never move because of one.
 */
export const runtimeRules = pgTable(
  'runtime_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** The share of matching new servers it sends, 0 to 100, by server id so the answer is stable. */
    percent: integer('percent').notNull(),
    /** Owners whose new servers it matches; empty matches every owner. */
    accounts: uuid('accounts').array().notNull().default(sql`'{}'::uuid[]`),
    /** Product regions it matches; empty matches every region. */
    regions: text('regions').array().notNull().default(sql`'{}'::text[]`),
    /** Plans it matches; empty matches every plan. */
    plans: text('plans').array().notNull().default(sql`'{}'::text[]`),
    note: text('note').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [check('runtime_rules_percent', sql`${t.percent} between 0 and 100`)],
)

export const runtimeDecisionKind = pgEnum('runtime_decision_kind', [
  /** Where a new server was placed. */
  'placed',
  /** Its runtime had no room at its first start: it went to the rule's fallback instead. */
  'fell_back',
  'move_requested',
  'move_cancelled',
  'moved',
  /** A move that didn't finish: the server stayed where it was. */
  'move_failed',
])

/**
 * Every decision about which runtime a server is on, and why, so where each server runs can be
 * explained: its placement, a fallback, a move asked for and how it ended.
 */
export const runtimeDecisions = pgTable(
  'runtime_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    kind: runtimeDecisionKind('kind').notNull(),
    /** The runtime the server is on, or is to go to, after this decision. */
    provider: text('provider').notNull(),
    /** The runtime it was on before, where this decision changed that. */
    fromProvider: text('from_provider'),
    ruleId: uuid('rule_id').references(() => runtimeRules.id),
    reason: text('reason').notNull(),
    /** Each runtime looked at, and why it was or wasn't chosen. */
    considered: jsonb('considered').$type<RuntimeConsideredJson[]>().notNull().default([]),
    decidedBy: text('decided_by').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('runtime_decisions_server').on(t.serverId, t.at), index('runtime_decisions_at').on(t.at)],
)
