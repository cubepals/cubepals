// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Someone who came to a server while it rested for its owner's play: the free trial's hours, all
 * played. The edge lets every join to a server that isn't running in to wait, and says so
 * (a connect, `EdgeService.recordSession`), but one to a resting server can only be turned away
 * (`apps/edge/resting.ts`). So a connect to a resting server is a turned-away join: kept for the
 * owner to see who came by, unless it was the server's own main player, and counted, either way.
 *
 * Not for deciding whether a server rests (the access policy refuses its start), or for what the
 * player is told (the edge's).
 */
import type { ServerView } from '@blockly/contracts'
import { type Queryable, schema } from '@blockly/db'
import { and, desc, eq, gt, max } from 'drizzle-orm'
import { entitlementsOf } from '../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { playTotal } from '../accounts/play-total.ts'
import { FUNNEL, noteOnce } from '../insight/record.ts'

/** Why a server rests for its owner's play, as its stop says: the free trial's hours are played. */
export type Resting = 'free_hours'

const cameBy = schema.serverTurnedAway
const players = schema.serverPlayers

/** Whether an owner's free trial's hours are all played now, so no wake of theirs starts. */
export async function trialPlayed(q: Queryable, ownerId: string, now: Date): Promise<boolean> {
  const standing = await loadStanding(q, ownerId)
  const total = await playTotal(q, standing, entitlementsOf(standing), now)
  return total !== null && total.left <= 0
}

/**
 * Why `server` rests for its owner's play now, where it does: asleep or at rest, whatever stopped
 * it (its own idle time can come first), while the free trial's hours are all played.
 */
export async function restingFor(q: Queryable, server: MinecraftServer, now: Date): Promise<Resting | null> {
  const { status } = server.lifecycle
  if (status !== 'stopped' && status !== 'stored') return null
  return (await trialPlayed(q, server.ownerId, now)) ? 'free_hours' : null
}

/**
 * A join to `server`, resting for `reason`, was turned away. Nothing links an account to a player,
 * so the server's main player, the one it has seen play longest, counts as its owner: anyone else
 * is kept for the owner, their latest try only. Every one is counted.
 */
export async function turnedAway(
  q: Queryable,
  server: Pick<MinecraftServer, 'id' | 'ownerId'>,
  player: { uuid: string; name: string },
  reason: Resting,
  at: Date,
): Promise<void> {
  const [main] = await q
    .select({ uuid: players.playerUuid })
    .from(players)
    .where(and(eq(players.serverId, server.id), gt(players.playedSeconds, 0)))
    .orderBy(desc(players.playedSeconds))
    .limit(1)
  const friend = main?.uuid !== player.uuid
  if (friend)
    await q
      .insert(cameBy)
      .values({ serverId: server.id, playerUuid: player.uuid, playerName: player.name, reason, at })
      .onConflictDoUpdate({
        target: [cameBy.serverId, cameBy.playerUuid],
        set: { playerName: player.name, reason, at },
      })
  await noteOnce(q, {
    event: FUNNEL.joinTurnedAway,
    subject: `${server.id}:${player.uuid}:${at.toISOString()}`,
    userId: server.ownerId,
    properties: { serverId: server.id, reason, player: player.name, friend },
    at,
  })
}

/**
 * Who came by while the server rested, since it last stopped, newest first, as the owner's page
 * reads them: what they see the next time they look. Nothing once it has run again.
 */
export async function cameByView(
  q: Queryable,
  server: Pick<MinecraftServer, 'id' | 'lifecycle'>,
): Promise<ServerView['cameBy']> {
  if (server.lifecycle.status !== 'stopped') return []
  const [stopped] = await q
    .select({ at: max(schema.powerIntervals.stoppedAt) })
    .from(schema.powerIntervals)
    .where(eq(schema.powerIntervals.serverId, server.id))
  if (!stopped?.at) return []
  const rows = await q
    .select({ name: cameBy.playerName, uuid: cameBy.playerUuid, at: cameBy.at })
    .from(cameBy)
    .where(and(eq(cameBy.serverId, server.id), gt(cameBy.at, stopped.at)))
    .orderBy(desc(cameBy.at))
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }))
}
