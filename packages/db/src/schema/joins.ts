// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every join to a server as one row, put together from the edge's half and the server's own
 * (`app/joins/`); the signals raised on them; and the last word each server's reporter gave as it
 * booted. Joins and signals are kept 35 days, and a join's `source` an hour at most.
 */
import { sql } from 'drizzle-orm'
import { bigint, bigserial, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { ts } from './columns.ts'
import { minecraftServers } from './servers.ts'

// ─── Joins ──────────────────────────────────────────────────────────────────────────────────

/**
 * One connection to a server: a join, or a `look` (a server-list ping no join followed). Each
 * column is written once, by whichever report says it first.
 */
export const joins = pgTable(
  'joins',
  {
    /** The edge's id for the connection; a server's report with no edge half gets one of its own. */
    id: uuid('id').primaryKey(),
    kind: text('kind').$type<'join' | 'look'>().notNull(),
    serverId: uuid('server_id').references(() => minecraftServers.id, { onDelete: 'cascade' }),
    edgeId: text('edge_id'),
    edgeRegion: text('edge_region'),
    /** The hostname dialled. */
    address: text('address').notNull(),
    /** The server's own address, a kept one, or one on a play domain being moved off. */
    addressKind: text('address_kind').$type<'own' | 'kept' | 'old_domain'>(),
    protocol: integer('protocol'),
    playerName: text('player_name'),
    playerUuid: uuid('player_uuid'),
    /** A hash of the client's network, keyed to the server, as `known_addresses` keeps it. */
    network: text('network'),
    /** `ip:port` of the client, kept only until the row is put together, an hour at most. */
    source: text('source'),
    path: text('path').$type<'direct' | 'held' | 'refused'>(),
    pingedAt: ts('pinged_at'),
    connectedAt: ts('connected_at').notNull(),
    wakeAskedAt: ts('wake_asked_at'),
    wakeOperationId: uuid('wake_operation_id'),
    readyAt: ts('ready_at'),
    handedAt: ts('handed_at'),
    loginAt: ts('login_at'),
    configureStartedAt: ts('configure_started_at'),
    configuredAt: ts('configured_at'),
    inWorldAt: ts('in_world_at'),
    leftAt: ts('left_at'),
    leftReason: text('left_reason'),
    pingedAfterAt: ts('pinged_after_at'),
    bytesUp: bigint('bytes_up', { mode: 'number' }),
    bytesDown: bigint('bytes_down', { mode: 'number' }),
    /** How the server ticked as the player came in. */
    tick: jsonb('tick').$type<{ tps: number; mspt: number; online: number }>(),
    /** Whether the server's reporter told its half: `not_reported` until it does. */
    serverSide: text('server_side').$type<'not_reported' | 'reported'>().notNull().default('not_reported'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('joins_server').on(t.serverId, t.connectedAt.desc()),
    index('joins_player').on(t.playerUuid, t.connectedAt.desc()),
    index('joins_player_name').on(sql`lower(${t.playerName})`, t.connectedAt.desc()),
    index('joins_address').on(t.address, t.connectedAt.desc()),
    index('joins_source').on(t.source).where(sql`${t.source} is not null`),
    // The signals job reads every join of the last few minutes, whatever its server or player.
    index('joins_connected').on(t.connectedAt),
  ],
)

// ─── Signals ────────────────────────────────────────────────────────────────────────────────

/**
 * Something about a join or a server worth an operator's look, raised once per `key` and open
 * until an operator closes it or a day passes (`closed_by = 'system:expired'`).
 */
export const signals = pgTable(
  'signals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    serverId: uuid('server_id'),
    joinId: uuid('join_id'),
    /** What makes it the same signal, so it is raised once. */
    key: text('key').notNull().unique(),
    at: ts('at').notNull(),
    /** The server's and player's names, the address, the figure and its limit. */
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    closedAt: ts('closed_at'),
    /** The operator who closed it, or `system:expired`. */
    closedBy: text('closed_by'),
  },
  (t) => [index('signals_at').on(t.at), index('signals_open').on(t.at).where(sql`${t.closedAt} is null`)],
)

// ─── Server reports ─────────────────────────────────────────────────────────────────────────

/** The latest `boot` each server's reporter sent: its Paper and the plugins listening at login. */
export const serverReports = pgTable('server_reports', {
  serverId: uuid('server_id')
    .primaryKey()
    .references(() => minecraftServers.id, { onDelete: 'cascade' }),
  reportedAt: ts('reported_at').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
})
