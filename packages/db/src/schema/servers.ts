/**
 * A Minecraft server and what it is made of: its record and status, its revisions and worlds, the
 * runtime binding its compute lives behind, and the operations that change it. Who may join is
 * `access.ts`'s; backups are `backups.ts`'s.
 */
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type {
  AppliedConfigJson,
  CarriedFileJson,
  FailureJson,
  ObservedJson,
  OperationProgressJson,
  PinnedModJson,
  PinnedModpackJson,
  ServerSettingsJson,
} from '../json.ts'
import { users } from './auth.ts'
import { createdAt, ts, updatedAt } from './columns.ts'

// ─── Minecraft servers ──────────────────────────────────────────────────────────────────────

export const serverStatus = pgEnum('server_status', [
  'provisioning',
  'stopped',
  'starting',
  'running',
  'stopping',
  'updating',
  'restoring',
  'relocating',
  'failed',
  'deleted',
  'purged',
  /** Its world is being packed away, and its compute and storage let go. Brief. */
  'storing',
  /**
   * Nobody played for a while: its world is in the archive store, and it holds no compute and no
   * storage. A join or a start brings it back, from that copy.
   */
  'stored',
])
export const stopReason = pgEnum('stop_reason', [
  'user',
  'idle',
  'policy',
  'entitlement',
  'crash',
  'maintenance',
  'session_cap',
])
export const loader = pgEnum('loader', ['vanilla', 'paper', 'fabric', 'quilt', 'neoforge', 'forge'])

export const minecraftServers = pgTable(
  'minecraft_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    /** What the owner says about it, for the people they share it with. */
    description: text('description').notNull().default(''),
    /** One of Blockly's own icons, by key; null until the owner picks one. */
    icon: text('icon'),
    /** Up to five words from a fixed set, for the directory's filters. */
    tags: text('tags').array().notNull().default([]),
    slug: text('slug').notNull(),
    /**
     * The secret half of the server's invite link. Whoever holds it may open the server's page and,
     * while the whitelist is on, put themselves on it. Resetting issues a new one.
     */
    inviteCode: text('invite_code').notNull(),
    regionKey: text('region_key').notNull(),
    memoryTier: text('memory_tier').notNull(),
    status: serverStatus('status').notNull(),
    stopReason: stopReason('stop_reason'),
    failure: jsonb('failure').$type<FailureJson>(),
    desiredRevisionId: uuid('desired_revision_id').references((): AnyPgColumn => serverRevisions.id),
    activeWorldId: uuid('active_world_id').references((): AnyPgColumn => worlds.id),
    version: integer('version').notNull().default(0),
    createIdempotencyKey: text('create_idempotency_key').notNull(),
    /**
     * How it was made: from a template, a pack Blockly offers by name (`curated`), a modpack found
     * in the catalog, a copy of a server someone shared, a server an invite opened, or directly
     * through the API. It tells which ways to start people use; null for servers made before it was
     * kept.
     */
    createdFrom: text('created_from').$type<
      'template' | 'curated' | 'modpack' | 'upload' | 'copy' | 'invite' | 'direct'
    >(),
    /** A server made for a while: Blockly deletes it then, unless its owner keeps it (§15.6). */
    expiresAt: ts('expires_at'),
    /**
     * When someone last played on it, or its owner last started it: what storing a world nobody
     * plays counts from. A run a connection woke that nobody joined doesn't move it.
     */
    lastActiveAt: ts('last_active_at').notNull().defaultNow(),
    /** When its world was stored away; null while it has storage of its own. */
    storedAt: ts('stored_at'),
    /**
     * The warnings sent before its world is deleted for going unplayed, as
     * `<last active, ISO>:<days before>:<sent at, ISO>`; null before any. Tied to when it was
     * last played, so playing again starts it over.
     */
    deletionWarned: text('deletion_warned'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
    purgeAfter: ts('purge_after'),
  },
  (t) => [
    uniqueIndex('servers_slug_live').on(t.slug).where(sql`${t.deletedAt} is null`),
    uniqueIndex('servers_invite_code').on(t.inviteCode),
    uniqueIndex('servers_create_idem').on(t.ownerId, t.createIdempotencyKey),
    index('servers_owner_live').on(t.ownerId).where(sql`${t.deletedAt} is null`),
  ],
)

export const retiredSlugs = pgTable('retired_slugs', {
  slug: text('slug').primaryKey(),
  serverId: uuid('server_id').notNull(),
  retiredAt: ts('retired_at').notNull(),
  availableAfter: ts('available_after').notNull(),
})

export const serverRevisions = pgTable(
  'server_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references((): AnyPgColumn => minecraftServers.id),
    number: integer('number').notNull(),
    gameVersion: text('game_version').notNull(),
    loader: loader('loader').notNull(),
    loaderVersion: text('loader_version'),
    settings: jsonb('settings').$type<ServerSettingsJson>().notNull(),
    mods: jsonb('mods').$type<PinnedModJson[]>().notNull().default([]),
    /** The modpack it plays instead of a mod list of its own (§15.6). */
    modpack: jsonb('modpack').$type<PinnedModpackJson>(),
    /** Files Cubepals wrote for what it plays, written where they go before every start. */
    files: jsonb('files').$type<CarriedFileJson[]>().notNull().default([]),
    /** sha512s of taken-down jars the owner chose to run anyway (§15.3). */
    acknowledgedRevoked: jsonb('acknowledged_revoked').$type<string[]>().notNull().default([]),
    reason: text('reason').notNull(),
    basedOnRevisionId: uuid('based_on_revision_id'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('revisions_server_number').on(t.serverId, t.number),
    index('revisions_mods_gin').using('gin', sql`${t.mods} jsonb_path_ops`),
  ],
)

export const worlds = pgTable(
  'worlds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references((): AnyPgColumn => minecraftServers.id),
    levelName: text('level_name').notNull(),
    /** What the owner calls it. */
    name: text('name').notNull(),
    seed: text('seed'),
    levelType: text('level_type').notNull().default('minecraft:normal'),
    hardcore: boolean('hardcore').notNull().default(false),
    generatedOnVersion: text('generated_on_version').notNull(),
    createdAt: createdAt(),
    /** The owner deleted it; the row stays for the backups that were taken of it. */
    deletedAt: ts('deleted_at'),
    /** Its directories were removed from the volume (`prune_worlds`). */
    prunedAt: ts('pruned_at'),
  },
  (t) => [uniqueIndex('worlds_server_level').on(t.serverId, t.levelName)],
)

export const serverRuntimes = pgTable('server_runtimes', {
  serverId: uuid('server_id')
    .primaryKey()
    .references(() => minecraftServers.id),
  provider: text('provider').notNull(),
  handle: text('handle'),
  placementRegionKey: text('placement_region_key'),
  applied: jsonb('applied').$type<AppliedConfigJson>(),
  observed: jsonb('observed').$type<ObservedJson>(),
  /**
   * When the installed jars were last found wrong. The artifact endpoint reports this as their
   * Last-Modified, so the image downloads them again on the next boot (§15.2).
   */
  artifactsRefreshedAt: ts('artifacts_refreshed_at'),
  /**
   * The disk its world has grown into, in GB, where that is more than its plan starts a server
   * on; null until it outgrew that. Storage never shrinks at the provider, and neither does this.
   */
  storageGb: integer('storage_gb'),
  /** What its world took on disk when last measured, as it stopped, and when. */
  diskUsedBytes: bigint('disk_used_bytes', { mode: 'number' }),
  diskCheckedAt: ts('disk_checked_at'),
  /**
   * The runtime an operator asked this server to move to (docs/runtimes.md), until it has: it
   * moves at its next quiet moment, as a misplaced server does. Null when it stays where it is.
   */
  moveTo: text('move_to'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const operationKind = pgEnum('operation_kind', [
  'provision',
  'start',
  'stop',
  'restart',
  'apply',
  'relocate',
  'backup',
  'archive',
  'restore',
  'access_sync',
  'prune_worlds',
  'decommission',
  'purge',
  /** A world nobody plays packed into the archive store, then its compute and storage let go. */
  'store',
  /** A stored world brought back onto fresh storage and compute, and booted. */
  'unstore',
])
export const operationStatus = pgEnum('operation_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

export const serverOperations = pgTable(
  'server_operations',
  {
    // Equal to the pg-boss job id.
    id: uuid('id').primaryKey(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    kind: operationKind('kind').notNull(),
    status: operationStatus('status').notNull().default('queued'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    requestedBy: text('requested_by').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    progress: jsonb('progress').$type<OperationProgressJson>(),
    /** What went wrong, in the words owners read. */
    error: text('error'),
    /**
     * What went wrong as the provider, the database or the platform said it, causes included:
     * for whoever looks after the platform, never shown to owners.
     */
    detail: text('detail'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('operations_idem').on(t.serverId, t.idempotencyKey),
    index('operations_server_recent').on(t.serverId, t.createdAt),
    // Several access edits in a row need one delivery, not one each.
    uniqueIndex('operations_one_queued_access_sync')
      .on(t.serverId)
      .where(sql`${t.kind} = 'access_sync' and ${t.status} = 'queued'`),
  ],
)
