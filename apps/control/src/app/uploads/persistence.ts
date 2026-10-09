import { type Queryable, schema } from '@blockly/db'
import { eq, isNotNull, lt, or } from 'drizzle-orm'

const pending = schema.pendingUploads

export interface PendingUpload {
  id: string
  ownerId: string
  /** Null for a pack uploaded while a server is being made. */
  serverId: string | null
  kind: 'mod' | 'world' | 'pack'
  key: string
  fileName: string
  sizeBytes: number
  sha512: string | null
  finishedAt: Date | null
  createdAt: Date
}

/** A browser was handed a link to put a file at `key`; what it said about the file comes along. */
export async function insertPendingUpload(
  q: Queryable,
  upload: Omit<PendingUpload, 'finishedAt' | 'createdAt'>,
): Promise<PendingUpload> {
  const [row] = await q.insert(pending).values(upload).returning()
  if (!row) throw new Error('The upload just recorded is missing')
  return row
}

export async function loadPendingUpload(q: Queryable, id: string): Promise<PendingUpload | null> {
  const [row] = await q.select().from(pending).where(eq(pending.id, id))
  return row ?? null
}

/** Taken in: whatever is left at its key is a staging copy to delete. */
export async function finishPendingUpload(q: Queryable, id: string, at: Date): Promise<void> {
  await q.update(pending).set({ finishedAt: at }).where(eq(pending.id, id))
}

export async function deletePendingUpload(q: Queryable, id: string): Promise<void> {
  await q.delete(pending).where(eq(pending.id, id))
}

/** Uploads whose leftovers can go: finished ones, and ones nobody finished in time. */
export async function uploadsToClear(
  q: Queryable,
  startedBefore: Date,
  limit = 200,
): Promise<PendingUpload[]> {
  return q
    .select()
    .from(pending)
    .where(or(isNotNull(pending.finishedAt), lt(pending.createdAt, startedBefore)))
    .limit(limit)
}
