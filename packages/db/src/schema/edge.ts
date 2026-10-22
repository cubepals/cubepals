// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edges: each machine that routes players to servers, and how far its routes are known to go;
 * and the addresses a server's own players last joined it from, which may wake it with a ping.
 */
import { sql } from 'drizzle-orm'
import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { ts } from './columns.ts'
import { minecraftServers } from './servers.ts'

// ─── Edges ──────────────────────────────────────────────────────────────────────────────────

/**
 * Each edge that has asked for routes, by its own id. A server reads as running only once every
 * edge seen lately holds its route (`app/edge/routed.ts`).
 */
export const edges = pgTable('edges', {
  edgeId: text('edge_id').primaryKey(),
  /** When it first asked: it holds back only servers that became running after this. */
  firstSeenAt: ts('first_seen_at').notNull().default(sql`clock_timestamp()`),
  /**
   * The newest route version it holds every route of: the database's time as that route list's
   * read began. Null until it has said so once.
   */
  syncedTo: ts('synced_to'),
  /** When its agent last started, as it says; null for an edge that doesn't say. */
  startedAt: ts('started_at'),
  /** When it last asked; an edge not seen for a while no longer counts. */
  seenAt: ts('seen_at').notNull(),
})

// ─── Known addresses ────────────────────────────────────────────────────────────────────────

/**
 * The networks a server's own players joined it from lately, each only as a hash keyed to the
 * server, never the address itself: a server-list ping from one may wake the server before the
 * join (`app/edge/known-addresses.ts`). Nothing says who joined from it. A row is forgotten once
 * it no longer counts.
 */
export const knownAddresses = pgTable(
  'known_addresses',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    /** The network's hash, under a key of the server's own. */
    address: text('address').notNull(),
    /** When a join from it last ended that the server itself had seen on. */
    seenAt: ts('seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.address] }), index('known_addresses_seen').on(t.seenAt)],
)
