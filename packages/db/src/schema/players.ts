/**
 * One player on one server, beyond who may join (`access.ts`): what their files said when the
 * server last went to sleep, and what the owner asked for while they were away, waiting for them
 * to join.
 */
import { jsonb, pgEnum, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import type { PlayerSnapshotJson } from '../json.ts'
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

/** A trip somewhere, or a game mode: a player has at most one of each waiting. */
export const playerActionKind = pgEnum('player_action_kind', ['place', 'game_mode'])

/** Asked for while the player was away; done through the console when they next join, then gone. */
export const playerActionsWaiting = pgTable(
  'player_actions_waiting',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    playerUuid: uuid('player_uuid').notNull(),
    kind: playerActionKind('kind').notNull(),
    /** `death` or `spawn` for a place; the mode for a game mode. */
    what: text('what').notNull(),
    /** Their name when it was asked, for the audit and the page until the server names them again. */
    playerName: text('player_name').notNull(),
    requestedBy: text('requested_by').notNull(),
    askedAt: ts('asked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.playerUuid, t.kind] })],
)
