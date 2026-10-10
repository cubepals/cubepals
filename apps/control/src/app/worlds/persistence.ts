// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import type { World } from '../../domain/world/world.ts'

const worlds = schema.worlds

export interface WorldRecord extends World {
  createdAt: Date
  deletedAt: Date | null
  prunedAt: Date | null
}

/** Every world the server has had, deleted ones too: a level directory is never reused. */
export async function listWorlds(q: Queryable, serverId: string): Promise<WorldRecord[]> {
  return q.select().from(worlds).where(eq(worlds.serverId, serverId)).orderBy(asc(worlds.createdAt))
}

export async function insertWorld(tx: Tx, world: Omit<World, 'id'>): Promise<WorldRecord> {
  const [row] = await tx.insert(worlds).values(world).returning()
  if (!row) throw new Error('The world just inserted is missing')
  return row
}

export async function markWorldDeleted(tx: Tx, worldId: string, at: Date): Promise<void> {
  await tx.update(worlds).set({ deletedAt: at }).where(eq(worlds.id, worldId))
}

/** Deleted worlds whose directories are still on the volume, except one the server runs again. */
export async function awaitingPrune(
  q: Queryable,
  serverId: string,
  activeWorldId: string | null,
): Promise<WorldRecord[]> {
  return q
    .select()
    .from(worlds)
    .where(
      and(
        eq(worlds.serverId, serverId),
        isNotNull(worlds.deletedAt),
        isNull(worlds.prunedAt),
        ...(activeWorldId === null ? [] : [ne(worlds.id, activeWorldId)]),
      ),
    )
}

export async function markPruned(q: Queryable, worldIds: string[], at: Date): Promise<void> {
  if (worldIds.length === 0) return
  await q.update(worlds).set({ prunedAt: at }).where(inArray(worlds.id, worldIds))
}

/**
 * After a restore: the world it brought back is the server's again, and every deleted world's
 * directories may be back on the volume with it, to be removed again.
 */
export async function reopenWorlds(tx: Tx, serverId: string, activeWorldId: string): Promise<void> {
  await tx.update(worlds).set({ deletedAt: null, prunedAt: null }).where(eq(worlds.id, activeWorldId))
  await tx
    .update(worlds)
    .set({ prunedAt: null })
    .where(and(eq(worlds.serverId, serverId), isNotNull(worlds.deletedAt)))
}

/** A world restored from an upload is the world the upload held: its facts replace the row's. */
export async function setWorldFacts(
  tx: Tx,
  worldId: string,
  facts: { seed: string | null; levelType: string; hardcore: boolean; gameVersion: string },
): Promise<void> {
  await tx
    .update(worlds)
    .set({
      seed: facts.seed,
      levelType: facts.levelType,
      hardcore: facts.hardcore,
      generatedOnVersion: facts.gameVersion,
    })
    .where(eq(worlds.id, worldId))
}
