// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The world downloads made of archives, as rows: the one being made or ready for an archive, the
 * newest whatever its state, and those whose copy the store no longer needs. What a download
 * holds and how it is made is `downloads.ts`'s.
 */
import { type Queryable, schema } from '@blockly/db'
import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm'
import type { BackupStatus } from './persistence.ts'

const downloads = schema.worldDownloads

export interface DownloadRecord {
  id: string
  backupId: string
  key: string
  status: BackupStatus
  sizeBytes: number | null
  error: string | null
  expiresAt: Date
  createdAt: Date
}

/** The copy an archive has being made or ready, if any: there is never more than one. */
export async function liveDownload(q: Queryable, backupId: string): Promise<DownloadRecord | null> {
  const [row] = await q
    .select()
    .from(downloads)
    .where(and(eq(downloads.backupId, backupId), inArray(downloads.status, ['pending', 'ready'])))
  return row ?? null
}

/** The newest copy asked of an archive, whatever became of it. */
export async function newestDownload(q: Queryable, backupId: string): Promise<DownloadRecord | null> {
  const [row] = await q
    .select()
    .from(downloads)
    .where(eq(downloads.backupId, backupId))
    .orderBy(desc(downloads.createdAt))
    .limit(1)
  return row ?? null
}

export async function loadDownload(q: Queryable, id: string): Promise<DownloadRecord | null> {
  const [row] = await q.select().from(downloads).where(eq(downloads.id, id))
  return row ?? null
}

/**
 * A copy to make, unless the archive already has one being made or ready: then null, and the
 * caller reads that one. Two asks at once make one copy.
 */
export async function insertDownload(
  q: Queryable,
  row: { id: string; backupId: string; key: string; expiresAt: Date },
): Promise<DownloadRecord | null> {
  const [inserted] = await q
    .insert(downloads)
    .values(row)
    .onConflictDoNothing({
      target: downloads.backupId,
      where: sql`${downloads.status} in ('pending', 'ready')`,
    })
    .returning()
  return inserted ?? null
}

export async function setDownload(
  q: Queryable,
  id: string,
  change: Partial<Pick<DownloadRecord, 'status' | 'sizeBytes' | 'error' | 'expiresAt'>>,
): Promise<void> {
  await q.update(downloads).set(change).where(eq(downloads.id, id))
}

/**
 * Copies the store need not keep: past their day, replaced or failed, or of an archive that is
 * no longer there to download.
 */
export async function downloadsToErase(q: Queryable, now: Date, limit = 100): Promise<DownloadRecord[]> {
  const rows = await q
    .select({ download: downloads })
    .from(downloads)
    .innerJoin(schema.backups, eq(schema.backups.id, downloads.backupId))
    .where(
      or(
        inArray(downloads.status, ['failed', 'expired', 'deleted']),
        lt(downloads.expiresAt, now),
        ne(schema.backups.status, 'ready'),
      ),
    )
    .limit(limit)
  return rows.map((row) => row.download)
}

/** The store no longer holds these copies. */
export async function downloadsErased(q: Queryable, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await q.delete(downloads).where(inArray(downloads.id, [...ids]))
}
