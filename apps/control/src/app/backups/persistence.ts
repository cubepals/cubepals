import { type Queryable, schema, type UploadedWorldFactsJson } from '@blockly/db'
import { and, count, desc, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm'
import type { SnapshotHandle } from '../ports/runtime.ts'

const backups = schema.backups

export type BackupTier = 'snapshot' | 'archive'
export type BackupTrigger =
  | 'scheduled'
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

/** A provider snapshot that exists, recorded as a ready backup. */
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
      status: 'ready',
      snapshotHandle: input.snapshot,
      sizeBytes: input.sizeBytes,
      expiresAt: input.expiresAt,
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
