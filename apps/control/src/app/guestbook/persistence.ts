import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, count, desc, eq } from 'drizzle-orm'

const stars = schema.serverStars
const notes = schema.serverNotes

export interface NoteRecord {
  id: string
  serverId: string
  authorId: string
  body: string
  createdAt: Date
}

/**
 * A star set on or off. Says whether that changed anything: setting it the way it already is
 * leaves it, and its count, alone.
 */
export async function setStar(tx: Tx, serverId: string, userId: string, starred: boolean): Promise<boolean> {
  const changed = starred
    ? await tx.insert(stars).values({ serverId, userId }).onConflictDoNothing().returning()
    : await tx
        .delete(stars)
        .where(and(eq(stars.serverId, serverId), eq(stars.userId, userId)))
        .returning()
  return changed.length > 0
}

export async function countStars(q: Queryable, serverId: string): Promise<number> {
  const [row] = await q.select({ n: count() }).from(stars).where(eq(stars.serverId, serverId))
  return row?.n ?? 0
}

async function starredBy(q: Queryable, serverId: string, userId: string): Promise<boolean> {
  const [row] = await q
    .select({ userId: stars.userId })
    .from(stars)
    .where(and(eq(stars.serverId, serverId), eq(stars.userId, userId)))
  return row !== undefined
}

export async function countNotes(q: Queryable, serverId: string): Promise<number> {
  const [row] = await q.select({ n: count() }).from(notes).where(eq(notes.serverId, serverId))
  return row?.n ?? 0
}

/** A server's stars and notes, and whether the person reading starred it. */
export async function tally(
  q: Queryable,
  serverId: string,
  viewerId: string | null,
): Promise<{ stars: number; notes: number; starred: boolean }> {
  return {
    stars: await countStars(q, serverId),
    notes: await countNotes(q, serverId),
    starred: viewerId !== null && (await starredBy(q, serverId, viewerId)),
  }
}

/** The latest notes on a server, newest first (`server_notes_server`). */
export async function latestNotes(q: Queryable, serverId: string, limit: number): Promise<NoteRecord[]> {
  return q
    .select()
    .from(notes)
    .where(eq(notes.serverId, serverId))
    .orderBy(desc(notes.createdAt))
    .limit(limit)
}

/** What one person has left on one server and not deleted. */
export async function notesBy(q: Queryable, serverId: string, authorId: string): Promise<NoteRecord[]> {
  return q
    .select()
    .from(notes)
    .where(and(eq(notes.serverId, serverId), eq(notes.authorId, authorId)))
}

export async function insertNote(
  tx: Tx,
  note: { serverId: string; authorId: string; body: string },
): Promise<string> {
  const [row] = await tx.insert(notes).values(note).returning({ id: notes.id })
  if (!row) throw new Error('The note was not written')
  return row.id
}

export async function loadNote(q: Queryable, id: string): Promise<NoteRecord | null> {
  const [row] = await q.select().from(notes).where(eq(notes.id, id))
  return row ?? null
}

/** Deleted outright. Says whether it was still there, for two deletes that cross. */
export async function deleteNote(tx: Tx, id: string): Promise<boolean> {
  return (await tx.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id })).length > 0
}

/** What a closed account left on other people's servers: its stars and its notes. */
export async function forgetAccount(tx: Tx, userId: string): Promise<void> {
  await tx.delete(stars).where(eq(stars.userId, userId))
  await tx.delete(notes).where(eq(notes.authorId, userId))
}
