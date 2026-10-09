/**
 * A server's backups: provider snapshots and copies in the archive store, with what each was made
 * from and where it stands. The files themselves are `artifacts.ts`'s.
 */
import { sql } from 'drizzle-orm'
import { bigint, check, index, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { UploadedWorldFactsJson } from '../json.ts'
import { createdAt, ts } from './columns.ts'
import { minecraftServers, serverRevisions, worlds } from './servers.ts'

// ─── Backups and artifacts ──────────────────────────────────────────────────────────────────

export const backupTier = pgEnum('backup_tier', ['snapshot', 'archive'])
export const backupTrigger = pgEnum('backup_trigger', [
  'scheduled',
  'pre_apply',
  'pre_restore',
  'pre_relocate',
  'manual',
  /** A world someone uploaded: a download of theirs, brought back. */
  'uploaded',
  /** The copy of a world stored while nobody plays: while it is stored, its only one. */
  'stored',
])
export const backupStatus = pgEnum('backup_status', ['pending', 'ready', 'failed', 'expired', 'deleted'])

export const backups = pgTable(
  'backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => serverRevisions.id),
    tier: backupTier('tier').notNull(),
    trigger: backupTrigger('trigger').notNull(),
    status: backupStatus('status').notNull().default('pending'),
    snapshotHandle: text('snapshot_handle'),
    archiveKey: text('archive_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /**
     * An archive's sha256, as the runtime that wrote it said: a restore from it is checked against
     * it where the runtime can check. None for an uploaded world, or an archive made before it was kept.
     */
    sha256: text('sha256'),
    expiresAt: ts('expires_at'),
    /**
     * An uploaded world's own facts, read from its files: its world row takes them when it is
     * restored, since the row may have been made for another world with the same folder name.
     */
    worldFacts: jsonb('world_facts').$type<UploadedWorldFactsJson>(),
    /** Why a backup that failed couldn't be made, for its owner. */
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    index('backups_server_recent').on(t.serverId, t.createdAt),
    // Only snapshots have a provider handle, and every snapshot that was made has one; a failed
    // snapshot records the attempt without one (§9: backup `failed`, server unaffected).
    check('backups_handle_only_on_snapshots', sql`${t.tier} = 'snapshot' or ${t.snapshotHandle} is null`),
    check(
      'backups_ready_snapshot_has_handle',
      sql`${t.tier} <> 'snapshot' or ${t.status} in ('failed', 'deleted') or ${t.snapshotHandle} is not null`,
    ),
  ],
)

/**
 * A world download: an archive's world, without what Blockly may not hand on, copied into the
 * store when its owner asks for it and kept a day for the link to point at. One copy at a time
 * is being made or ready per archive, so two asks at once make it once.
 */
export const worldDownloads = pgTable(
  'world_downloads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    backupId: uuid('backup_id')
      .notNull()
      .references(() => backups.id),
    key: text('key').notNull(),
    /** `pending` while the worker makes it; `expired` once it is past its day or replaced. */
    status: backupStatus('status').notNull().default('pending'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Why it couldn't be made, as its owner reads it. */
    error: text('error'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('world_downloads_one_live').on(t.backupId).where(sql`${t.status} in ('pending', 'ready')`),
  ],
)
