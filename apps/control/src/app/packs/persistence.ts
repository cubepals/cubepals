// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type PackImportJson, type PackLeftOutJson, type Queryable, schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import type { Loader } from '../../domain/revision/revision.ts'
import type { BuiltContents } from './build.ts'

const imports = schema.packImports
const contents = schema.packContents

/** What a pack file holds, by its sha512 (docs/modpack-system.md). */
export type PackContentsRecord = BuiltContents & { sha512: string }

export async function loadPackContents(q: Queryable, sha512: string): Promise<PackContentsRecord | null> {
  const [row] = await q.select().from(contents).where(eq(contents.sha512, sha512))
  if (!row) return null
  return {
    sha512: row.sha512,
    name: row.name,
    versionLabel: row.versionLabel,
    gameVersion: row.gameVersion,
    loader: row.loader as Loader,
    loaderVersion: row.loaderVersion,
    playersNeedIt: row.playersNeedIt,
    jars: row.jars,
    leftOut: row.leftOut,
    memoryMb: row.memoryMb,
  }
}

/** Kept once per file: the same bytes always hold the same things. */
export async function savePackContents(q: Queryable, record: PackContentsRecord): Promise<void> {
  await q
    .insert(contents)
    .values({
      sha512: record.sha512,
      name: record.name,
      versionLabel: record.versionLabel,
      gameVersion: record.gameVersion,
      loader: record.loader,
      loaderVersion: record.loaderVersion,
      playersNeedIt: record.playersNeedIt,
      jars: record.jars,
      leftOut: record.leftOut,
      memoryMb: record.memoryMb,
    })
    .onConflictDoNothing()
}

/**
 * One more jar a pack's servers leave out, learned after the pack was read. Says whether it was
 * new: the same jar learned twice is recorded once.
 */
export async function leavePackJarOut(
  q: Queryable,
  sha512: string,
  entry: PackLeftOutJson,
): Promise<boolean> {
  const [row] = await q
    .select({ leftOut: contents.leftOut })
    .from(contents)
    .where(eq(contents.sha512, sha512))
  if (row === undefined || row.leftOut.some((l) => l.path === entry.path)) return false
  await q
    .update(contents)
    .set({ leftOut: [...row.leftOut, entry] })
    .where(eq(contents.sha512, sha512))
  return true
}

/** A jar a pack's servers left out that they run after all. Says whether it had been left out. */
export async function keepPackJar(q: Queryable, sha512: string, path: string): Promise<boolean> {
  const [row] = await q
    .select({ leftOut: contents.leftOut })
    .from(contents)
    .where(eq(contents.sha512, sha512))
  if (row === undefined || !row.leftOut.some((l) => l.path === path)) return false
  await q
    .update(contents)
    .set({ leftOut: row.leftOut.filter((l) => l.path !== path) })
    .where(eq(contents.sha512, sha512))
  return true
}

export interface PackImportRecord {
  id: string
  ownerId: string
  fileName: string
  sizeBytes: number
  status: 'reading' | 'ready' | 'refused'
  packSha512: string | null
  result: PackImportJson | null
  refusal: string | null
  detail: string | null
  createdAt: Date
  finishedAt: Date | null
}

export async function insertPackImport(
  q: Queryable,
  row: { id: string; ownerId: string; fileName: string; sizeBytes: number },
): Promise<void> {
  await q.insert(imports).values(row)
}

export async function loadPackImport(q: Queryable, id: string): Promise<PackImportRecord | null> {
  const [row] = await q.select().from(imports).where(eq(imports.id, id))
  return row ?? null
}

export async function packImportReady(
  q: Queryable,
  id: string,
  ready: { packSha512: string | null; result: PackImportJson; at: Date },
): Promise<void> {
  await q
    .update(imports)
    .set({ status: 'ready', packSha512: ready.packSha512, result: ready.result, finishedAt: ready.at })
    .where(and(eq(imports.id, id), eq(imports.status, 'reading')))
}

export async function packImportRefused(
  q: Queryable,
  id: string,
  refused: { refusal: string; detail: string; at: Date },
): Promise<void> {
  await q
    .update(imports)
    .set({ status: 'refused', refusal: refused.refusal, detail: refused.detail, finishedAt: refused.at })
    .where(and(eq(imports.id, id), eq(imports.status, 'reading')))
}
