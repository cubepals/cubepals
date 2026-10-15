// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Storage a rebuild on another host kept rather than deleted (`server_runtimes.kept_storage`): the
 * old copy of a world whose host couldn't run it, kept beside the new one for `KEEP_MS` in case
 * the rebuild missed anything. The leftovers sweep is told to keep it until then, and lets it go
 * after; the platform's alerts count it meanwhile. What a rebuild is, is `handlers/moving.ts`'s.
 */
import { DAY_MS } from '@blockly/contracts/durations'
import { type Queryable, schema } from '@blockly/db'
import { eq, isNotNull, sql } from 'drizzle-orm'
import type { HeldStorage, RuntimeHandle } from '../ports/runtime.ts'

const runtimes = schema.serverRuntimes

/** How long a rebuild's old storage is kept: a week to notice the rebuild missed something. */
export const KEEP_MS = 7 * DAY_MS

/** Keeps the storage `handle` names beside whatever the server runs on now. */
export async function keepStorage(
  q: Queryable,
  serverId: string,
  handle: RuntimeHandle,
  at: Date,
): Promise<void> {
  const kept = JSON.stringify([{ handle, at: at.toISOString() }])
  await q
    .update(runtimes)
    .set({ keptStorage: sql`coalesce(${runtimes.keptStorage}, '[]'::jsonb) || ${kept}::jsonb` })
    .where(eq(runtimes.serverId, serverId))
}

/**
 * The storage still kept for a server at `now`, by the handles that named it. What has been kept
 * for `KEEP_MS` is let go from the record, so the next clearing of leftovers deletes it.
 */
export async function keptStorage(q: Queryable, serverId: string, now: Date): Promise<RuntimeHandle[]> {
  const [row] = await q
    .select({ kept: runtimes.keptStorage })
    .from(runtimes)
    .where(eq(runtimes.serverId, serverId))
  const kept = row?.kept ?? []
  const still = kept.filter((k) => now.getTime() - Date.parse(k.at) < KEEP_MS)
  if (still.length < kept.length)
    await q
      .update(runtimes)
      .set({ keptStorage: still.length === 0 ? null : still })
      .where(eq(runtimes.serverId, serverId))
  return still.map((k) => k.handle as RuntimeHandle)
}

/**
 * The storage a server holds, as provisioning is told of it: its world is on what `held` names,
 * never on what a rebuild kept.
 */
export async function heldStorage(
  q: Queryable,
  serverId: string,
  held: RuntimeHandle | null,
): Promise<HeldStorage> {
  return { held, kept: await keptStorage(q, serverId, new Date()) }
}

/** The servers that keep a rebuild's old storage now. */
export async function serversKeepingStorage(q: Queryable): Promise<string[]> {
  const rows = await q
    .select({ serverId: runtimes.serverId })
    .from(runtimes)
    .where(isNotNull(runtimes.keptStorage))
  return rows.map((row) => row.serverId)
}
