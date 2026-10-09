/**
 * Who may join a server and who runs it: the whitelist, operators and bans, as Blockly keeps them
 * and as the game reports them back.
 */
import { boolean, integer, jsonb, pgEnum, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import type { AccessDetailsJson } from '../json.ts'
import { ts, updatedAt } from './columns.ts'
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
})

export const accessList = pgEnum('access_list', ['whitelist', 'operator', 'ban'])
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
