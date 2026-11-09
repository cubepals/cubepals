// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly keeps about one player beyond who may join: the snapshot their files gave as their
 * server went to sleep, and what waits for them to join. Who has played, and when, is
 * `servers/usage.ts`'s; this only reads it.
 */
import type { WAITING_KINDS } from '@blockly/contracts'
import { type ItemStackJson, type PlayerSnapshotJson, type Queryable, schema, type Tx } from '@blockly/db'
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'

const snapshots = schema.serverPlayerSnapshots
const waiting = schema.playerActionsWaiting
const kept = schema.playerInventoriesKept

export type WaitingKind = (typeof WAITING_KINDS)[number]

export interface WaitingAction {
  playerUuid: string
  playerName: string
  kind: WaitingKind
  what: string
  requestedBy: string
  askedAt: Date
}

/** A server's snapshot, all of it: the players its files had as it stopped, and nobody else. */
export async function replaceSnapshots(
  q: Queryable,
  serverId: string,
  takenAt: Date,
  players: ReadonlyMap<string, PlayerSnapshotJson>,
): Promise<void> {
  await q.delete(snapshots).where(eq(snapshots.serverId, serverId))
  if (players.size === 0) return
  await q
    .insert(snapshots)
    .values([...players].map(([playerUuid, facts]) => ({ serverId, playerUuid, takenAt, facts })))
}

export async function loadSnapshot(
  q: Queryable,
  serverId: string,
  playerUuid: string,
): Promise<{ takenAt: Date; facts: PlayerSnapshotJson } | null> {
  const [row] = await q
    .select({ takenAt: snapshots.takenAt, facts: snapshots.facts })
    .from(snapshots)
    .where(and(eq(snapshots.serverId, serverId), eq(snapshots.playerUuid, playerUuid)))
  return row ?? null
}

/** Waiting for one player, or for whichever of `players` are given. */
export async function listWaiting(
  q: Queryable,
  serverId: string,
  players: readonly string[],
): Promise<WaitingAction[]> {
  if (players.length === 0) return []
  return q
    .select({
      playerUuid: waiting.playerUuid,
      playerName: waiting.playerName,
      kind: waiting.kind,
      what: waiting.what,
      requestedBy: waiting.requestedBy,
      askedAt: waiting.askedAt,
    })
    .from(waiting)
    .where(and(eq(waiting.serverId, serverId), inArray(waiting.playerUuid, [...players])))
}

/** The lock a server's deliveries take turns on (`ports/locks.ts`), and every ask with them. */
export function deliveriesKey(serverId: string): string {
  return `blockly:player-waits:${serverId}`
}

/**
 * Takes the deliveries' lock until `tx` ends, as `PgAdvisoryLocks` takes it for a delivery: an ask
 * adds to what waits only between deliveries, so a delivery and an ask never read the same rows.
 */
export async function holdDeliveries(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
}

/** What is written replaces what waited of its kind; how two asks meet is `kept-powers.ts`'s. */
export async function putWaiting(q: Queryable, serverId: string, action: WaitingAction): Promise<void> {
  await q
    .insert(waiting)
    .values({ serverId, ...action })
    .onConflictDoUpdate({
      target: [waiting.serverId, waiting.playerUuid, waiting.kind],
      set: {
        what: action.what,
        playerName: action.playerName,
        requestedBy: action.requestedBy,
        askedAt: action.askedAt,
      },
    })
}

/** Takes it away, and says what it was; null where nothing of that kind waited. */
export async function dropWaiting(
  q: Queryable,
  serverId: string,
  playerUuid: string,
  kind: WaitingKind,
): Promise<{ what: string } | null> {
  const [row] = await q
    .delete(waiting)
    .where(and(eq(waiting.serverId, serverId), eq(waiting.playerUuid, playerUuid), eq(waiting.kind, kind)))
    .returning({ what: waiting.what })
  return row ?? null
}

/** What still waits of a kind, once part of it was done. */
export async function updateWaiting(
  q: Queryable,
  serverId: string,
  playerUuid: string,
  kind: WaitingKind,
  what: string,
): Promise<void> {
  await q
    .update(waiting)
    .set({ what })
    .where(and(eq(waiting.serverId, serverId), eq(waiting.playerUuid, playerUuid), eq(waiting.kind, kind)))
}

export interface KeptInventory {
  id: string
  playerUuid: string
  keptAt: Date
  requestedBy: string
  items: ItemStackJson[]
}

/** One player's kept inventories, newest first. */
export async function listKept(q: Queryable, serverId: string, playerUuid: string): Promise<KeptInventory[]> {
  return q
    .select({
      id: kept.id,
      playerUuid: kept.playerUuid,
      keptAt: kept.keptAt,
      requestedBy: kept.requestedBy,
      items: kept.items,
    })
    .from(kept)
    .where(and(eq(kept.serverId, serverId), eq(kept.playerUuid, playerUuid)))
    .orderBy(desc(kept.keptAt))
}

export async function addKept(q: Queryable, serverId: string, row: KeptInventory): Promise<void> {
  await q.insert(kept).values({ serverId, ...row })
}

export async function dropKept(q: Queryable, serverId: string, id: string): Promise<void> {
  await q.delete(kept).where(and(eq(kept.serverId, serverId), eq(kept.id, id)))
}

/**
 * Drops one past the newest few, unless it is being put back (claimed since `stale`): true where
 * it was dropped, so the world may forget it too.
 */
export async function dropIdleKept(
  q: Queryable,
  serverId: string,
  id: string,
  stale: Date,
): Promise<boolean> {
  const dropped = await q
    .delete(kept)
    .where(
      and(
        eq(kept.serverId, serverId),
        eq(kept.id, id),
        or(isNull(kept.puttingBackSince), lt(kept.puttingBackSince, stale)),
      ),
    )
    .returning({ id: kept.id })
  return dropped.length > 0
}

/**
 * Takes one to put back, where no one else is putting it back, or whoever was gave up before
 * `stale`: the row, or null where it isn't there or is taken.
 */
export async function claimKept(
  q: Queryable,
  serverId: string,
  id: string,
  now: Date,
  stale: Date,
): Promise<KeptInventory | null> {
  const [row] = await q
    .update(kept)
    .set({ puttingBackSince: now })
    .where(
      and(
        eq(kept.serverId, serverId),
        eq(kept.id, id),
        or(isNull(kept.puttingBackSince), lt(kept.puttingBackSince, stale)),
      ),
    )
    .returning({
      id: kept.id,
      playerUuid: kept.playerUuid,
      keptAt: kept.keptAt,
      requestedBy: kept.requestedBy,
      items: kept.items,
    })
  return row ?? null
}

/** Let go of one that was being put back and isn't all back, for the next ask. */
export async function releaseKept(q: Queryable, serverId: string, id: string): Promise<void> {
  await q
    .update(kept)
    .set({ puttingBackSince: null })
    .where(and(eq(kept.serverId, serverId), eq(kept.id, id)))
}

/** Someone who has played here: their newest name and when they were last on. */
export async function playedHere(
  q: Queryable,
  serverId: string,
  playerUuid: string,
): Promise<{ name: string; lastSeenAt: Date } | null> {
  const played = schema.serverPlayers
  const [row] = await q
    .select({ name: played.playerName, lastSeenAt: played.lastSeenAt })
    .from(played)
    .where(and(eq(played.serverId, serverId), eq(played.playerUuid, playerUuid)))
  return row ?? null
}

/** With the server purged, nothing about its players is needed. */
export async function forgetPlayers(q: Queryable, serverId: string): Promise<void> {
  await q.delete(snapshots).where(eq(snapshots.serverId, serverId))
  await q.delete(waiting).where(eq(waiting.serverId, serverId))
  await q.delete(kept).where(eq(kept.serverId, serverId))
  await q.delete(schema.serverTurnedAway).where(eq(schema.serverTurnedAway.serverId, serverId))
}
