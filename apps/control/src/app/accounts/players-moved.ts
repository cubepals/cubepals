// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The facts `playersMoved` (`domain/account/free-links.ts`) is scored from: free accounts that
 * signed up in the last `movedLookMs`, the players their servers saw, the other free accounts
 * whose servers saw the same players, and whether the earlier of each pair had its players turned
 * away for its free hours shortly before the later signed up. Also the names of two accounts'
 * players in common, as the alert inbox shows a pair. Scoring, grouping and what Blockly does
 * with a group are `free-links.ts`'s; this only finds candidates.
 */
import type { WakeResult } from '@blockly/contracts/edge'
import { type Queryable, schema } from '@blockly/db'
import { and, eq, gt, gte, inArray, isNotNull, lte } from 'drizzle-orm'
import { playersMoved } from '../../domain/account/free-links.ts'
import { paidForPlayer } from '../../domain/account/free-play.ts'
import { tuning } from '../tuning.ts'
import { addCandidate, type Candidates } from './free-links.ts'
import { loadStanding } from './persistence.ts'

const played = schema.serverPlayers
const servers = schema.minecraftServers
const users = schema.users

/** How the edge ends a join turned away because the account's free hours ran out. */
const OUT_OF_HOURS = `refused:${'quota' satisfies Extract<WakeResult, { outcome: 'denied' }>['reason']}`

/**
 * Pairs of free accounts, one of them new, whose players are the same, the later one signed up
 * soon after the earlier one's players were turned away for its free hours.
 */
export async function movedPlayerPairs(q: Queryable, now: Date): Promise<Candidates> {
  const found: Candidates = new Map()
  const fresh = await q
    .selectDistinct({ ownerId: servers.ownerId })
    .from(played)
    .innerJoin(servers, eq(servers.id, played.serverId))
    .innerJoin(users, eq(users.id, servers.ownerId))
    .where(
      and(
        isNotNull(played.confirmedAt),
        gt(users.createdAt, new Date(now.getTime() - tuning().freeLinks.movedLookMs)),
      ),
    )
  const freshPlayers = await playersOf(
    q,
    fresh.map((r) => r.ownerId),
  )
  const uuids = [...new Set([...freshPlayers.values()].flatMap((set) => [...set]))]
  if (uuids.length === 0) return found
  const others = await q
    .selectDistinct({ ownerId: servers.ownerId })
    .from(played)
    .innerJoin(servers, eq(servers.id, played.serverId))
    .where(and(inArray(played.playerUuid, uuids), isNotNull(played.confirmedAt)))
  const players = await playersOf(q, [...new Set([...fresh, ...others].map((r) => r.ownerId))])
  const signedUp = await freeSignedUp(q, [...players.keys()], now)
  for (const [later, laterPlayers] of freshPlayers)
    for (const [earlier, earlierPlayers] of players) {
      const at = { later: signedUp.get(later), earlier: signedUp.get(earlier) }
      // Only free accounts, and only the later one's players moving from the earlier one.
      if (at.later === undefined || at.earlier === undefined || at.earlier >= at.later) continue
      const moved = playersMoved(earlierPlayers, laterPlayers, tuning().freeLinks)
      if (moved > 0 && (await ranOutBefore(q, earlier, at.later)))
        addCandidate(found, later, earlier, { playersMoved: moved })
    }
  return found
}

/** When each of these accounts that is a free one, and not a test account, signed up. */
async function freeSignedUp(q: Queryable, ids: readonly string[], now: Date): Promise<Map<string, Date>> {
  const free: string[] = []
  for (const id of ids) {
    const standing = await loadStanding(q, id, now)
    if (standing.plan === 'free' && !standing.testAccount) free.push(id)
  }
  if (free.length === 0) return new Map()
  const rows = await q
    .select({ id: users.id, createdAt: users.createdAt })
    .from(users)
    .where(inArray(users.id, free))
  return new Map(rows.map((row) => [row.id, row.createdAt]))
}

/** Each account's players: the Minecraft accounts its servers themselves saw, offline names aside. */
async function playersOf(q: Queryable, ownerIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const byOwner = new Map<string, Set<string>>()
  if (ownerIds.length === 0) return byOwner
  const rows = await q
    .selectDistinct({ ownerId: servers.ownerId, uuid: played.playerUuid })
    .from(played)
    .innerJoin(servers, eq(servers.id, played.serverId))
    .where(and(inArray(servers.ownerId, [...ownerIds]), isNotNull(played.confirmedAt)))
  for (const { ownerId, uuid } of rows) {
    if (!paidForPlayer(uuid)) continue
    byOwner.set(ownerId, (byOwner.get(ownerId) ?? new Set()).add(uuid))
  }
  return byOwner
}

/** Whether a join to one of the account's servers was turned away for its free hours in the `movedWithinMs` before `at`. */
async function ranOutBefore(q: Queryable, ownerId: string, at: Date): Promise<boolean> {
  const [row] = await q
    .select({ id: schema.joins.id })
    .from(schema.joins)
    .innerJoin(servers, eq(servers.id, schema.joins.serverId))
    .where(
      and(
        eq(servers.ownerId, ownerId),
        eq(schema.joins.leftReason, OUT_OF_HOURS),
        gte(schema.joins.connectedAt, new Date(at.getTime() - tuning().freeLinks.movedWithinMs)),
        lte(schema.joins.connectedAt, at),
      ),
    )
    .limit(1)
  return row !== undefined
}

/** The names of the players two accounts' servers both saw, as the later account's servers know them. */
export async function playersInCommon(q: Queryable, later: string, earlier: string): Promise<string[]> {
  const rows = await q
    .selectDistinct({ ownerId: servers.ownerId, uuid: played.playerUuid, name: played.playerName })
    .from(played)
    .innerJoin(servers, eq(servers.id, played.serverId))
    .where(and(inArray(servers.ownerId, [later, earlier]), isNotNull(played.confirmedAt)))
  const earlierSaw = new Set(rows.filter((r) => r.ownerId === earlier).map((r) => r.uuid))
  const names = new Map<string, string>()
  for (const row of rows)
    if (row.ownerId === later && earlierSaw.has(row.uuid) && paidForPlayer(row.uuid))
      names.set(row.uuid, row.name)
  return [...names.values()].sort((x, y) => x.localeCompare(y))
}
