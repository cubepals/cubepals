// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * World imports as rows: one made as its upload finishes, what reading it asked, answered, found or
 * refused. How a world is read and brought is `world-imports.ts`'s.
 */
import {
  type ModArtifactJson,
  type NewWorldFactsJson,
  type Queryable,
  schema,
  type WorldImportAnswerJson,
  type WorldImportQuestionJson,
} from '@blockly/db'
import { and, count, eq, gt, isNull, ne, sql } from 'drizzle-orm'

const imports = schema.worldImports

export type WorldImportRecord = typeof imports.$inferSelect

/** A new import for an upload just finished; false where the upload has one already. */
export async function insertWorldImport(
  q: Queryable,
  row: {
    id: string
    ownerId: string
    /** Null for a world brought while its server is being made. */
    serverId: string | null
    fileName: string
    sizeBytes: number
    name: string | null
  },
): Promise<boolean> {
  const made = await q.insert(imports).values(row).onConflictDoNothing().returning({ id: imports.id })
  return made.length > 0
}

export async function loadWorldImport(q: Queryable, id: string): Promise<WorldImportRecord | null> {
  const [row] = await q.select().from(imports).where(eq(imports.id, id))
  return row ?? null
}

/** What reading found it needs its owner to answer. */
export async function worldImportAsks(
  q: Queryable,
  id: string,
  question: WorldImportQuestionJson,
): Promise<void> {
  await q
    .update(imports)
    .set({ status: 'asking', question })
    .where(and(eq(imports.id, id), eq(imports.status, 'reading')))
}

/** Its owner answered: it is read again with the answer. False when it wasn't asking. */
export async function worldImportAnswered(
  q: Queryable,
  id: string,
  answer: WorldImportAnswerJson,
): Promise<boolean> {
  const taken = await q
    .update(imports)
    .set({ status: 'reading', answer })
    .where(and(eq(imports.id, id), eq(imports.status, 'asking')))
    .returning({ id: imports.id })
  return taken.length > 0
}

export async function worldImportReady(
  q: Queryable,
  id: string,
  result: { backupId: string; notes: string[]; at: Date },
): Promise<void> {
  await q
    .update(imports)
    .set({
      status: 'ready',
      backupId: result.backupId,
      notes: result.notes,
      finishedAt: result.at,
      question: null,
    })
    .where(eq(imports.id, id))
}

/** A world brought before its server, packed and kept for the server its owner makes from it. */
export async function newWorldImportReady(
  q: Queryable,
  id: string,
  result: { facts: NewWorldFactsJson; startsOn: ModArtifactJson; notes: string[]; at: Date },
): Promise<void> {
  await q
    .update(imports)
    .set({
      status: 'ready',
      facts: result.facts,
      startsOn: result.startsOn,
      notes: result.notes,
      finishedAt: result.at,
      question: null,
    })
    .where(eq(imports.id, id))
}

export async function worldImportRefused(
  q: Queryable,
  id: string,
  result: { refusal: string; detail?: string | undefined; at: Date },
): Promise<void> {
  await q
    .update(imports)
    .set({
      status: 'refused',
      refusal: result.refusal,
      detail: result.detail ?? null,
      finishedAt: result.at,
      question: null,
    })
    .where(and(eq(imports.id, id), eq(imports.status, 'reading')))
}

/** How many worlds its owner brought for a server not yet made since `since`. */
export async function worldsBroughtSince(q: Queryable, ownerId: string, since: Date): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(imports)
    .where(and(eq(imports.ownerId, ownerId), isNull(imports.serverId), gt(imports.createdAt, since)))
  return row?.n ?? 0
}

/**
 * Its owner's world for a server not yet made is ready: the ones they brought before it can't make
 * one any more, and what they stored is the store's sweep's to let go once nothing uses it. One
 * brought after it and ready first stays.
 */
export async function worldsBroughtBefore(q: Queryable, ownerId: string, latestId: string): Promise<void> {
  await q
    .update(imports)
    .set({ startsOn: null })
    .where(
      and(
        eq(imports.ownerId, ownerId),
        isNull(imports.serverId),
        ne(imports.id, latestId),
        sql`${imports.createdAt} < (select ${imports.createdAt} from ${imports} where ${imports.id} = ${latestId})`,
      ),
    )
}
