// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edges: each machine that routes players to servers, and how far its routes are known to go.
 */
import { pgTable, text } from 'drizzle-orm/pg-core'
import { ts } from './columns.ts'

// ─── Edges ──────────────────────────────────────────────────────────────────────────────────

/**
 * Each edge that has asked for routes, by its own id. A server reads as running only once every
 * edge seen lately holds its route (`app/edge/routed.ts`).
 */
export const edges = pgTable('edges', {
  edgeId: text('edge_id').primaryKey(),
  /**
   * The database's time when the newest route list this edge says it holds began to be read: it
   * holds the route of every server named running before then. Null until it has said so once.
   */
  syncedTo: ts('synced_to'),
  /** When it last asked; an edge not seen for a while no longer counts. */
  seenAt: ts('seen_at').notNull(),
})
