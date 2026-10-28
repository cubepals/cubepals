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
    otherJars: row.otherJars,
    leftOut: row.leftOut,
    memoryMb: row.memoryMb,
  }
}

/**
 * Kept once per file: the same bytes always hold the same things. A build reads more than a build
 * before it did, so a row kept before gets what this one adds: the jars placed outside the mods
 * (`otherJars`), when read, and the sha512 of each jar it leaves out where the row has none. What
 * the row learned since stays: each entry keeps its own `why` (`crashed`, `needed`).
 */
export async function savePackContents(q: Queryable, record: PackContentsRecord): Promise<void> {
  await q.transaction(async (tx) => {
    const inserted = await tx
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
        otherJars: record.otherJars ?? [],
        leftOut: record.leftOut,
        memoryMb: record.memoryMb,
      })
      .onConflictDoNothing()
      .returning({ sha512: contents.sha512 })
    if (inserted.length > 0) return
    const [row] = await tx
      .select({ leftOut: contents.leftOut })
      .from(contents)
      .where(eq(contents.sha512, record.sha512))
      .for('update')
    if (row === undefined) return
    const digests = new Map(
      record.leftOut.flatMap((l) => (l.sha512 === undefined ? [] : [[l.path, l.sha512]])),
    )
    const leftOut = row.leftOut.map((l) => {
      const sha512 = l.sha512 ?? digests.get(l.path)
      return sha512 === undefined ? l : { ...l, sha512 }
    })
    await tx
      .update(contents)
      .set({ leftOut, ...(record.otherJars === undefined ? {} : { otherJars: record.otherJars }) })
      .where(eq(contents.sha512, record.sha512))
  })
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

/**
 * A jar a pack's servers left out for players' games that they run after all: its entry becomes
 * `needed`, keeping its sha512, or taking `jarSha512` where it had none, so the jar checks still
 * find it (`servers/specs.ts`). Says whether it had been left out for players.
 */
export async function keepPackJar(
  q: Queryable,
  sha512: string,
  path: string,
  jarSha512?: string,
): Promise<boolean> {
  const [row] = await q
    .select({ leftOut: contents.leftOut })
    .from(contents)
    .where(eq(contents.sha512, sha512))
  if (row === undefined || !row.leftOut.some((l) => l.path === path && l.why === 'players')) return false
  await q
    .update(contents)
    .set({
      leftOut: row.leftOut.map((l) =>
        l.path === path && l.why === 'players'
          ? {
              ...l,
              why: 'needed' as const,
              ...(l.sha512 === undefined && jarSha512 ? { sha512: jarSha512 } : {}),
            }
          : l,
      ),
    })
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
  /** The world that came inside it, read from the same upload; null where it held none. */
  worldImportId: string | null
  bringsWorld: boolean
  createdAt: Date
  finishedAt: Date | null
}

export async function insertPackImport(
  q: Queryable,
  row: { id: string; ownerId: string; fileName: string; sizeBytes: number; bringsWorld?: boolean },
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
  ready: { packSha512: string | null; result: PackImportJson; at: Date; worldImportId?: string | null },
): Promise<void> {
  await q
    .update(imports)
    .set({
      status: 'ready',
      packSha512: ready.packSha512,
      result: ready.result,
      worldImportId: ready.worldImportId ?? null,
      finishedAt: ready.at,
    })
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
