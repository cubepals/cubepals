// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the product's owner learns about how it is used (docs/metrics.md, "Insight"): each funnel
 * event, kept once here before it is sent, and the short question asked at a good moment.
 */
import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { ts } from './columns.ts'

/**
 * A funnel event, written in the transaction of what it describes, then sent by the worker. The
 * unique pair is what "once" means: one per account (`signed_up`) or server (`server_created`)
 * as its name says. A row stays after it is sent, so it is never sent twice.
 */
export const insightEvents = pgTable(
  'insight_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    event: text('event').notNull(),
    /** What it happened once to: an account's id, a server's id, or an account and a plan. */
    subject: text('subject').notNull(),
    /** The account it is about; the event's distinct id. Never an email. */
    userId: text('user_id').notNull(),
    properties: jsonb('properties').$type<Record<string, string | number | boolean>>().notNull().default({}),
    at: ts('at').notNull().defaultNow(),
    /** When it reached the analytics service; null while it waits. */
    sentAt: ts('sent_at'),
  },
  (t) => [
    uniqueIndex('insight_events_once').on(t.event, t.subject),
    index('insight_events_unsent').on(t.at).where(sql`${t.sentAt} is null`),
  ],
)

/**
 * A good moment the owner may be asked about ("How's it going?"), one per account and moment.
 * Shown, answered and dismissed are each set once; a dismissed one is never asked again.
 */
export const insightAsks = pgTable(
  'insight_asks',
  {
    userId: text('user_id').notNull(),
    moment: text('moment').notNull(),
    /** What the question says it noticed: the server's name, and the friend's for a join. */
    detail: jsonb('detail').$type<{ serverName: string; player?: string }>().notNull(),
    at: ts('at').notNull(),
    shownAt: ts('shown_at'),
    answeredAt: ts('answered_at'),
    dismissedAt: ts('dismissed_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.moment] })],
)
