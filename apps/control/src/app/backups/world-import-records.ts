// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * World imports as rows: one made as its upload finishes, what reading it asked, answered, found or
 * refused. How a world is read and brought is `world-imports.ts`'s.
 */
import { type Queryable, schema, type WorldImportAnswerJson, type WorldImportQuestionJson } from '@blockly/db'
import { and, eq } from 'drizzle-orm'

const imports = schema.worldImports

export type WorldImportRecord = typeof imports.$inferSelect

/** A new import for an upload just finished; false where the upload has one already. */
export async function insertWorldImport(
  q: Queryable,
  row: {
    id: string
    ownerId: string
    serverId: string
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
