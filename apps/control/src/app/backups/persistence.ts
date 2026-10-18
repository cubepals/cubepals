// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Queryable, schema, type UploadedWorldFactsJson } from '@blockly/db'
import { and, count, desc, eq, gte, inArray, isNotNull, lt, ne } from 'drizzle-orm'
import type { SnapshotHandle } from '../ports/runtime.ts'

const backups = schema.backups

export type BackupTier = 'snapshot' | 'archive'
export type BackupTrigger =
  | 'scheduled'
  /** Taken as a server goes to sleep after people played. */
  | 'sleep'
  | 'pre_apply'
  | 'pre_restore'
  | 'pre_relocate'
  | 'manual'
  | 'uploaded'
  /** The copy of a world stored away while nobody plays. */
  | 'stored'
export type BackupStatus = 'pending' | 'ready' | 'failed' | 'expired' | 'deleted'

export interface BackupRecord {
  id: string
  serverId: string
  worldId: string
  /** What was applied when it was taken, so a restore can offer that configuration back. */
  revisionId: string
  tier: BackupTier
  trigger: BackupTrigger
  status: BackupStatus
  snapshotHandle: SnapshotHandle | null
  archiveKey: string | null
  sizeBytes: number | null
  /** An archive's sha256, as the runtime that wrote it said: what a restore from it is checked against. */
  sha256: string | null
  expiresAt: Date | null
  /** An uploaded world's own facts, which its world row takes when it is restored. */
  worldFacts: UploadedWorldFactsJson | null
  /** Why it couldn't be made, when it failed. */
  error: string | null
  createdAt: Date
}

const toBackup = (row: typeof backups.$inferSelect): BackupRecord => ({
  ...row,
  snapshotHandle: row.snapshotHandle as SnapshotHandle | null,
})

/**
 * A provider snapshot that exists, recorded as a ready backup; with `error`, as one that failed,
 * its handle kept for the operation that took it to go back to.
 */
export async function recordSnapshot(
  q: Queryable,
  input: {
    serverId: string
    worldId: string
    revisionId: string
    trigger: BackupTrigger
    snapshot: SnapshotHandle
    sizeBytes: number
    expiresAt: Date | null
    error?: string | null
  },
): Promise<BackupRecord> {
  const [row] = await q
    .insert(backups)
    .values({
      serverId: input.serverId,
      worldId: input.worldId,
      revisionId: input.revisionId,
      tier: 'snapshot',
      trigger: input.trigger,
      status: input.error == null ? 'ready' : 'failed',
      snapshotHandle: input.snapshot,
      sizeBytes: input.sizeBytes,
      expiresAt: input.expiresAt,
      error: input.error ?? null,
    })
    .returning()
  if (!row) throw new Error('The backup just recorded is missing')
  return toBackup(row)
}

export async function loadBackup(q: Queryable, id: string): Promise<BackupRecord | null> {
  const [row] = await q.select().from(backups).where(eq(backups.id, id))
  return row ? toBackup(row) : null
}

export async function listBackups(q: Queryable, serverId: string): Promise<BackupRecord[]> {
  const rows = await q
    .select()
    .from(backups)
    .where(eq(backups.serverId, serverId))
    .orderBy(desc(backups.createdAt))
  return rows.map(toBackup)
}

/** The newest backup of a server taken for one reason, such as the snapshot before an apply. */
export async function latestBackup(
  q: Queryable,
  serverId: string,
  trigger: BackupTrigger,
  tier: BackupTier = 'snapshot',
): Promise<BackupRecord | null> {
  const [row] = await q
    .select()
    .from(backups)
    .where(and(eq(backups.serverId, serverId), eq(backups.trigger, trigger), eq(backups.tier, tier)))
    .orderBy(desc(backups.createdAt))
    .limit(1)
  return row ? toBackup(row) : null
}

/**
 * What an owner goes back to after play: one taken as the server slept, the day's, or their own.
 * Every other snapshot is a safety copy from before a change, kept apart.
 */
const RESTORE_POINTS: readonly BackupTrigger[] = ['sleep', 'scheduled', 'manual']

/**
 * The newest restore point a server can go back to: nothing was played since it when the server's
 * last player was seen before it was taken.
 */
export async function latestRestorePoint(q: Queryable, serverId: string): Promise<BackupRecord | null> {
  const [row] = await q
    .select()
    .from(backups)
    .where(
      and(
        eq(backups.serverId, serverId),
        eq(backups.tier, 'snapshot'),
        eq(backups.status, 'ready'),
        inArray(backups.trigger, [...RESTORE_POINTS]),
      ),
    )
    .orderBy(desc(backups.createdAt))
    .limit(1)
  return row ? toBackup(row) : null
}

/**
 * An archive on its way: the key it will have is recorded from the start, so whatever reaches
 * the store is found again and deleted if the archive never becomes ready.
 */
export async function insertArchive(
  q: Queryable,
  input: {
    id: string
    serverId: string
    worldId: string
    revisionId: string
    trigger: BackupTrigger
    archiveKey: string
    status?: 'pending' | 'ready'
    sizeBytes?: number
    expiresAt?: Date | null
    worldFacts?: UploadedWorldFactsJson
  },
): Promise<BackupRecord> {
  const [row] = await q
    .insert(backups)
    .values({
      id: input.id,
      serverId: input.serverId,
      worldId: input.worldId,
      revisionId: input.revisionId,
      tier: 'archive',
      trigger: input.trigger,
      status: input.status ?? 'pending',
      archiveKey: input.archiveKey,
      sizeBytes: input.sizeBytes ?? null,
      expiresAt: input.expiresAt ?? null,
      worldFacts: input.worldFacts ?? null,
    })
    .returning()
  if (!row) throw new Error('The archive just recorded is missing')
  return toBackup(row)
}

/**
 * The archive is in the store, whole: it can be downloaded and restored until it expires, and a
 * restore is checked against the sha256 its runtime said it has.
 */
export async function archiveReady(
  q: Queryable,
  id: string,
  written: { sizeBytes: number; sha256: string },
  expiresAt: Date | null,
): Promise<void> {
  await q
    .update(backups)
    .set({ status: 'ready', sizeBytes: written.sizeBytes, sha256: written.sha256, expiresAt })
    .where(and(eq(backups.id, id), eq(backups.status, 'pending')))
}

/** An archive that never became ready. Its key stays until whatever reached the store is deleted. */
export async function archiveFailed(q: Queryable, id: string, error: string): Promise<void> {
  await q
    .update(backups)
    .set({ status: 'failed', error })
    .where(and(eq(backups.id, id), eq(backups.status, 'pending')))
}

/** A snapshot that couldn't be made, kept so its owner sees the attempt and why (§9). */
export async function recordFailedSnapshot(
  q: Queryable,
  input: { serverId: string; worldId: string; revisionId: string; trigger: BackupTrigger; error: string },
): Promise<void> {
  await q.insert(backups).values({ ...input, tier: 'snapshot', status: 'failed' })
}

/**
 * Archives that are gone as far as anyone can see, but may still be in the store: deleted,
 * expired or failed ones that still have a key. Deleting from the store needs the archives
 * capability; without it, these wait for it to come back (§15.4).
 */
export async function archivesToErase(q: Queryable, limit = 100): Promise<BackupRecord[]> {
  const rows = await q
    .select()
    .from(backups)
    .where(
      and(
        eq(backups.tier, 'archive'),
        inArray(backups.status, ['failed', 'expired', 'deleted']),
        isNotNull(backups.archiveKey),
      ),
    )
    .limit(limit)
  return rows.map(toBackup)
}

/** The store no longer holds these archives. */
export async function archivesErased(q: Queryable, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await q
    .update(backups)
    .set({ archiveKey: null })
    .where(inArray(backups.id, [...ids]))
}

export async function setBackupStatus(
  q: Queryable,
  ids: readonly string[],
  status: BackupStatus,
): Promise<void> {
  if (ids.length === 0) return
  await q
    .update(backups)
    .set({ status })
    .where(inArray(backups.id, [...ids]))
}

/**
 * Backups whose time is up, retired, as read at `now`: only those still ready and still past their
 * expiry, so one kept for longer since it was read, or for good, as the copy a world rests in, stays.
 */
export async function expireDue(q: Queryable, ids: readonly string[], now: Date): Promise<void> {
  if (ids.length === 0) return
  await q
    .update(backups)
    .set({ status: 'expired' })
    .where(
      and(
        inArray(backups.id, [...ids]),
        eq(backups.status, 'ready'),
        isNotNull(backups.expiresAt),
        lt(backups.expiresAt, now),
      ),
    )
}

/**
 * The copy of a server's world made to rest it: its newest ready one. While
 * the server is stored it has no expiry, and it is the only copy of the world there is.
 */
export async function storedCopy(q: Queryable, serverId: string): Promise<BackupRecord | null> {
  const [row] = await q
    .select()
    .from(backups)
    .where(
      and(
        eq(backups.serverId, serverId),
        eq(backups.tier, 'archive'),
        eq(backups.trigger, 'stored'),
        eq(backups.status, 'ready'),
      ),
    )
    .orderBy(desc(backups.createdAt))
    .limit(1)
  return row ? toBackup(row) : null
}

/** When a backup goes: null keeps it until something else decides. */
export async function setExpiry(q: Queryable, id: string, expiresAt: Date | null): Promise<void> {
  await q.update(backups).set({ expiresAt }).where(eq(backups.id, id))
}

/** Its snapshots went with its storage: none of them can be restored any more. */
export async function expireSnapshotsOf(q: Queryable, serverId: string): Promise<void> {
  await q
    .update(backups)
    .set({ status: 'expired' })
    .where(and(eq(backups.serverId, serverId), eq(backups.tier, 'snapshot'), eq(backups.status, 'ready')))
}

/** A server's snapshots that can still be restored, newest first. */
export async function readySnapshots(q: Queryable, serverId: string): Promise<BackupRecord[]> {
  const rows = await q
    .select()
    .from(backups)
    .where(and(eq(backups.serverId, serverId), eq(backups.tier, 'snapshot'), eq(backups.status, 'ready')))
    .orderBy(desc(backups.createdAt))
  return rows.map(toBackup)
}

/**
 * The backups a queued or running operation of the server will read: an archive's snapshot, a
 * restore's backup, the snapshot a lost host is rebuilt from. `except` is the operation asking,
 * which has read its own by now.
 */
export async function backupsInUse(q: Queryable, serverId: string, except?: string): Promise<Set<string>> {
  const ops = schema.serverOperations
  const rows = await q
    .select({ kind: ops.kind, input: ops.input })
    .from(ops)
    .where(
      and(
        eq(ops.serverId, serverId),
        inArray(ops.status, ['queued', 'running']),
        inArray(ops.kind, ['archive', 'restore', 'relocate']),
        except === undefined ? undefined : ne(ops.id, except),
      ),
    )
  const named = rows.map(({ kind, input }) =>
    kind === 'archive' ? input.snapshotId : kind === 'restore' ? input.backupId : input.fromBackup,
  )
  return new Set(named.filter((id): id is string => typeof id === 'string'))
}

/** Ready backups whose provider has let them go by now. */
export async function pastExpiry(q: Queryable, now: Date): Promise<BackupRecord[]> {
  const rows = await q
    .select()
    .from(backups)
    .where(and(eq(backups.status, 'ready'), isNotNull(backups.expiresAt), lt(backups.expiresAt, now)))
  return rows.map(toBackup)
}

/** Downloads made of a server's world since `since`, on their way or ready: what a daily cap counts. */
export async function downloadsSince(q: Queryable, serverId: string, since: Date): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(backups)
    .where(
      and(
        eq(backups.serverId, serverId),
        eq(backups.tier, 'archive'),
        eq(backups.trigger, 'manual'),
        inArray(backups.status, ['pending', 'ready']),
        gte(backups.createdAt, since),
      ),
    )
  return row?.n ?? 0
}
