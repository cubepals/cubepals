// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, count, desc, eq, inArray } from 'drizzle-orm'

const stars = schema.serverStars
const notes = schema.serverNotes
const avatars = schema.writerAvatars

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

/** A note as it is shown: whether it was signed, and its writer's name as their account has it now. */
export interface ShownNoteRecord extends NoteRecord {
  signed: boolean
  authorName: string
}

/** The latest notes on a server, newest first (`server_notes_server`). */
export async function latestNotes(q: Queryable, serverId: string, limit: number): Promise<ShownNoteRecord[]> {
  return q
    .select({
      id: notes.id,
      serverId: notes.serverId,
      authorId: notes.authorId,
      body: notes.body,
      createdAt: notes.createdAt,
      signed: notes.signed,
      authorName: schema.users.name,
    })
    .from(notes)
    .innerJoin(schema.users, eq(schema.users.id, notes.authorId))
    .where(eq(notes.serverId, serverId))
    .orderBy(desc(notes.createdAt))
    .limit(limit)
}

/** The name an account has, as it signed up or as its sign-in provider gave it; empty when none. */
export async function accountName(q: Queryable, userId: string): Promise<string> {
  const [row] = await q
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
  return row?.name ?? ''
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

/** What a closed account left on other people's servers: its stars, its notes and its picture. */
export async function forgetAccount(tx: Tx, userId: string): Promise<void> {
  await tx.delete(stars).where(eq(stars.userId, userId))
  await tx.delete(notes).where(eq(notes.authorId, userId))
  await tx.delete(avatars).where(eq(avatars.userId, userId))
}

/** The picture style kept for each of these writers that has one, by account. */
export async function keptAvatarStyles(q: Queryable, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const rows = await q
    .select({ userId: avatars.userId, style: avatars.style })
    .from(avatars)
    .where(inArray(avatars.userId, userIds))
  return new Map(rows.map((row) => [row.userId, row.style]))
}

/** Keeps each writer's first picture style. One kept already stays as it is. */
export async function keepAvatarStyles(
  q: Queryable,
  given: { userId: string; style: string }[],
): Promise<void> {
  if (given.length > 0) await q.insert(avatars).values(given).onConflictDoNothing()
}
