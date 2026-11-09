// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One player on one server, beyond who may join (`access.ts`): what their files said when the
 * server last went to sleep, what the owner asked for while they were away, waiting for them to
 * join, and when they came by while it rested and couldn't get in.
 */
import { WAITING_KINDS } from '@blockly/contracts'
import { index, jsonb, pgEnum, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import type { ItemStackJson, PlayerSnapshotJson } from '../json.ts'
import { ts } from './columns.ts'
import { minecraftServers } from './servers.ts'

/**
 * A copy of each recent player's position, last death, game mode, items and stats, read from the
 * server's files as it stops: a sleeping server's volume is costly to read. Replaced at each stop.
 */
export const serverPlayerSnapshots = pgTable(
  'server_player_snapshots',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    playerUuid: uuid('player_uuid').notNull(),
    takenAt: ts('taken_at').notNull(),
    facts: jsonb('facts').$type<PlayerSnapshotJson>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.playerUuid] })],
)

/** A trip somewhere, a game mode, items, levels or an emptied inventory: at most one of each waits. */
export const playerActionKind = pgEnum('player_action_kind', WAITING_KINDS)

/** Asked for while the player was away; done through the console when they next join, then gone. */
export const playerActionsWaiting = pgTable(
  'player_actions_waiting',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    playerUuid: uuid('player_uuid').notNull(),
    kind: playerActionKind('kind').notNull(),
    /**
     * `death` or `spawn` for a place, or its coordinates as JSON; the mode for a game mode; the
     * items as JSON; the levels as a number; `all` for an emptied inventory.
     */
    what: text('what').notNull(),
    /** Their name when it was asked, for the audit and the page until the server names them again. */
    playerName: text('player_name').notNull(),
    requestedBy: text('requested_by').notNull(),
    askedAt: ts('asked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.playerUuid, t.kind] })],
)

/**
 * What a player carried when the owner emptied their inventory: the items are kept whole in the
 * world's own storage under `id` (`minecraft/kept-inventory.ts`); this row is what the page lists
 * and which copies the world still holds. The newest few per player; gone once put back.
 */
export const playerInventoriesKept = pgTable(
  'player_inventories_kept',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    id: text('id').notNull(),
    playerUuid: uuid('player_uuid').notNull(),
    keptAt: ts('kept_at').notNull(),
    requestedBy: text('requested_by').notNull(),
    items: jsonb('items').$type<ItemStackJson[]>().notNull(),
    /** Set while it is being put back, so two asks don't hand it out twice. */
    puttingBackSince: ts('putting_back_since'),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.id] }),
    index('player_inventories_kept_player').on(t.serverId, t.playerUuid),
  ],
)

/**
 * Someone the edge let in to wait while the server was resting for its owner's play, and who
 * could only be turned away: the latest time for each player, for the owner to see who came by.
 * Their name is as their client claimed it: shown to the owner, never decided by.
 */
export const serverTurnedAway = pgTable(
  'server_turned_away',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    playerUuid: uuid('player_uuid').notNull(),
    playerName: text('player_name').notNull(),
    /** Why it rested: `daily`, today's play used up, or `free_hours`, the free trial's. */
    reason: text('reason').notNull(),
    at: ts('at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.playerUuid] })],
)
