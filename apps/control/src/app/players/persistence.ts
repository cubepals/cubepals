// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Blockly keeps about one player beyond who may join: the snapshot their files gave as their
 * server went to sleep, and what waits for them to join. Who has played, and when, is
 * `servers/usage.ts`'s; this only reads it.
 */
import { type PlayerSnapshotJson, type Queryable, schema } from '@blockly/db'
import { and, eq, inArray } from 'drizzle-orm'

const snapshots = schema.serverPlayerSnapshots
const waiting = schema.playerActionsWaiting

export type WaitingKind = 'place' | 'game_mode'

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

/** The newest ask wins: a second trip replaces the first, and a second mode the first. */
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
}
