// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { type AccessEntry, type AccessRecord, entryKey, newAccessRecord } from '../../domain/access/access.ts'
import { lockServer } from '../servers/persistence.ts'

const access = schema.serverAccess
const entries = schema.serverAccessEntries

/** A record as read, with the stamps a later save uses to detect concurrent edits. */
export interface ReadRecord {
  record: AccessRecord
  version: number
  stamps: ReadonlyMap<string, number>
  syncedAt: Date | null
  syncError: string | null
}

type EntryRow = typeof entries.$inferSelect

const toEntry = (row: EntryRow): AccessEntry => ({
  list: row.list,
  player: { uuid: row.playerUuid, name: row.playerName },
  state: row.state,
  origin: row.origin,
  details: row.details,
  error: row.error,
})

export async function createAccess(q: Queryable, serverId: string): Promise<void> {
  const fresh = newAccessRecord()
  await q
    .insert(access)
    .values({ serverId, whitelistEnabled: fresh.whitelistEnabled, reseedRequired: fresh.reseedRequired })
    .onConflictDoNothing()
}

export async function readAccess(q: Queryable, serverId: string): Promise<ReadRecord> {
  const [head] = await q.select().from(access).where(eq(access.serverId, serverId))
  if (!head) throw new Error(`Server ${serverId} has no access record`)
  const rows = await q.select().from(entries).where(eq(entries.serverId, serverId))
  return {
    record: {
      whitelistEnabled: head.whitelistEnabled,
      whitelistEnabledPending: head.whitelistEnabledPending,
      reseedRequired: head.reseedRequired,
      entries: rows.map(toEntry),
    },
    version: head.version,
    stamps: new Map(rows.map((r) => [entryKey(r.list, r.playerUuid), r.updatedAt.getTime()])),
    syncedAt: head.syncedAt,
    syncError: head.syncError,
  }
}

/** Locks the record's head row, bumps its version and returns it. Every writer starts here. */
export async function lockAccess(tx: Tx, serverId: string): Promise<number> {
  const [head] = await tx
    .update(access)
    .set({ version: sql`${access.version} + 1` })
    .where(eq(access.serverId, serverId))
    .returning({ version: access.version })
  if (!head) throw new Error(`Server ${serverId} has no access record`)
  return head.version
}

export async function upsertEntry(
  tx: Tx,
  serverId: string,
  entry: AccessEntry,
  requestedBy: string | null,
): Promise<void> {
  const values = {
    serverId,
    list: entry.list,
    playerUuid: entry.player.uuid,
    playerName: entry.player.name,
    state: entry.state,
    origin: entry.origin,
    details: entry.details,
    error: entry.error,
    requestedBy,
    updatedAt: new Date(),
  }
  await tx
    .insert(entries)
    .values(values)
    .onConflictDoUpdate({ target: [entries.serverId, entries.list, entries.playerUuid], set: values })
}

export async function deleteEntry(
  tx: Tx,
  serverId: string,
  entry: Pick<AccessEntry, 'list' | 'player'>,
): Promise<void> {
  await tx
    .delete(entries)
    .where(
      and(
        eq(entries.serverId, serverId),
        eq(entries.list, entry.list),
        eq(entries.playerUuid, entry.player.uuid),
      ),
    )
}

export async function setWhitelistPending(tx: Tx, serverId: string, enabled: boolean | null): Promise<void> {
  await tx.update(access).set({ whitelistEnabledPending: enabled }).where(eq(access.serverId, serverId))
}

export async function markReseed(q: Queryable, serverId: string): Promise<void> {
  await q.update(access).set({ reseedRequired: true }).where(eq(access.serverId, serverId))
}

export async function recordSyncError(q: Queryable, serverId: string, error: string): Promise<void> {
  await q.update(access).set({ syncError: error }).where(eq(access.serverId, serverId))
}

/**
 * Saves a reconciled record without overwriting what people changed while it ran: an entry
 * edited or removed since `before` was read keeps its newer state, and one added meanwhile stays.
 *
 * The server's row is locked first, as every owner's change locks it: the entries this writes
 * point at that row, so saving one waits on it, and holding the access row while waiting is how
 * a change and a sync that met deadlocked (locks.test.ts).
 */
export async function saveReconciled(
  tx: Tx,
  serverId: string,
  before: ReadRecord,
  after: AccessRecord,
): Promise<number> {
  await lockServer(tx, serverId)
  const version = await lockAccess(tx, serverId)
  const current = await readAccess(tx, serverId)
  const afterByKey = new Map(after.entries.map((e) => [entryKey(e.list, e.player.uuid), e]))
  const keys = new Set([...before.stamps.keys(), ...afterByKey.keys()])

  for (const key of keys) {
    const readStamp = before.stamps.get(key)
    const nowStamp = current.stamps.get(key)
    const untouched = readStamp === nowStamp
    if (!untouched) continue
    const next = afterByKey.get(key)
    if (next) await upsertEntry(tx, serverId, next, null)
    else if (nowStamp !== undefined) {
      const gone = before.record.entries.find((e) => entryKey(e.list, e.player.uuid) === key)
      if (gone) await deleteEntry(tx, serverId, gone)
    }
  }

  // The whitelist mode follows the same rule: a newer request from a person wins.
  const modeUntouched = current.record.whitelistEnabledPending === before.record.whitelistEnabledPending
  await tx
    .update(access)
    .set({
      whitelistEnabled: after.whitelistEnabled,
      ...(modeUntouched ? { whitelistEnabledPending: after.whitelistEnabledPending } : {}),
      reseedRequired: after.reseedRequired,
      syncedAt: new Date(),
      syncError: null,
    })
    .where(eq(access.serverId, serverId))
  return version
}

/** IP bans reconciliation lifted since `since`, newest first (the `access.ip_ban_lifted` audit). */
export async function liftedIpBans(
  q: Queryable,
  serverId: string,
  since: Date,
): Promise<{ ip: string; at: string }[]> {
  const rows = await q
    .select({ data: schema.auditLog.data, at: schema.auditLog.at })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.subjectId, serverId),
        eq(schema.auditLog.action, 'access.ip_ban_lifted'),
        gte(schema.auditLog.at, since),
      ),
    )
    .orderBy(desc(schema.auditLog.at))
    .limit(10)
  return rows.map((row) => ({ ip: String((row.data as { ip?: string }).ip ?? ''), at: row.at.toISOString() }))
}
