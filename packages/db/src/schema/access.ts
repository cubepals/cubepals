// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who may join a server and who runs it: the whitelist, operators, bans and helpers, as Blockly
 * keeps them and as the game reports them back; and the warnings, mutes and bans given from
 * Cubepals, with how a server's punishments escalate; and Stop cheaters, the anticheat Cubepals
 * places itself: whether a server runs it, and the players it removed.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { AccessDetailsJson, ModerationStepJson } from '../json.ts'
import { createdAt, ts, updatedAt } from './columns.ts'
import { minecraftServers } from './servers.ts'

// ─── Live administration ────────────────────────────────────────────────────────────────────

export const serverAccess = pgTable('server_access', {
  serverId: uuid('server_id')
    .primaryKey()
    .references(() => minecraftServers.id),
  whitelistEnabled: boolean('whitelist_enabled').notNull().default(false),
  // Null means nothing is waiting to be delivered.
  whitelistEnabledPending: boolean('whitelist_enabled_pending'),
  // True until the first boot has imposed the record on the server's files.
  reseedRequired: boolean('reseed_required').notNull().default(true),
  syncedAt: ts('synced_at'),
  syncError: text('sync_error'),
  version: integer('version').notNull().default(0),
  // The owner's own escalation; null means Blockly's.
  moderationLadder: jsonb('moderation_ladder').$type<ModerationStepJson[]>(),
})

/** `unchecked`: players Stop cheaters leaves alone, through Grim's `grim.exempt` in LuckPerms. */
export const accessList = pgEnum('access_list', ['whitelist', 'operator', 'ban', 'helper', 'unchecked'])
export const accessEntryState = pgEnum('access_entry_state', [
  'active',
  'pending_add',
  'pending_remove',
  'rejected',
])
export const accessOrigin = pgEnum('access_origin', ['blockly', 'game'])

export const serverAccessEntries = pgTable(
  'server_access_entries',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    list: accessList('list').notNull(),
    playerUuid: uuid('player_uuid').notNull(),
    playerName: text('player_name').notNull(),
    state: accessEntryState('state').notNull(),
    origin: accessOrigin('origin').notNull(),
    details: jsonb('details').$type<AccessDetailsJson>().notNull().default({}),
    error: text('error'),
    requestedBy: text('requested_by'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.list, t.playerUuid] })],
)

// ─── Moderation ─────────────────────────────────────────────────────────────────────────────

export const moderationKind = pgEnum('moderation_kind', ['warn', 'mute', 'ban'])
export const moderationState = pgEnum('moderation_state', ['pending', 'delivered', 'lifting', 'lifted'])

/** Every warning, mute and ban given from Cubepals, kept as the player's history on that server. */
export const serverModerationActions = pgTable(
  'server_moderation_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    playerUuid: uuid('player_uuid').notNull(),
    playerName: text('player_name').notNull(),
    kind: moderationKind('kind').notNull(),
    reason: text('reason').notNull().default(''),
    // How long a mute or ban lasts from when it was given; null is for good, and always for a warning.
    minutes: integer('minutes'),
    state: moderationState('state').notNull(),
    error: text('error'),
    requestedBy: text('requested_by').notNull(),
    createdAt: createdAt(),
    deliveredAt: ts('delivered_at'),
    liftedAt: ts('lifted_at'),
  },
  (t) => [index('server_moderation_actions_server_idx').on(t.serverId, t.createdAt)],
)

// ─── Stop cheaters ──────────────────────────────────────────────────────────────────────────

/**
 * Whether a server runs Stop cheaters (`app/stop-cheaters/`): kept beside the server rather than in a
 * revision, so publishing and the owner's switch change it without a new revision, and going back to
 * an older revision never undoes it. A server with no row is `auto`. Which template a server was
 * made from is read from its creation in the audit log.
 */
export const serverStopCheaters = pgTable('server_stop_cheaters', {
  serverId: uuid('server_id')
    .primaryKey()
    .references(() => minecraftServers.id),
  /** `auto`, `on` or `off`; `off` is the owner's, and nothing automatic changes it. */
  setting: text('setting').$type<'auto' | 'on' | 'off'>().notNull().default('auto'),
  /** `browse` where publishing turned `auto` into `on`; null otherwise, and once the owner chooses. */
  reason: text('reason').$type<'browse'>(),
  /**
   * The owner asked for Cubepals' punishments in place of their own Grim settings: the next start
   * moves theirs aside, and the access sync after it, which reads that it did, clears this.
   */
  takeOver: boolean('take_over').notNull().default(false),
})

/** Each player Stop cheaters removed from a server, as the server's reporter told it. */
export const serverRemovals = pgTable(
  'server_removals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    playerUuid: uuid('player_uuid').notNull(),
    playerName: text('player_name').notNull(),
    reason: text('reason').$type<'movement' | 'speed' | 'impossible'>().notNull(),
    at: ts('at').notNull(),
  },
  (t) => [
    index('server_removals_server_at').on(t.serverId, t.at),
    index('server_removals_player').on(t.serverId, t.playerUuid, t.at),
    // One row for each removal, however many times a reporter sends the batch that holds it.
    uniqueIndex('server_removals_once').on(t.serverId, t.playerUuid, t.at, t.reason),
  ],
)
