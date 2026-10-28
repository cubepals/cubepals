// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Why the game turned a join away at login, where its reason is one of the lists Blockly keeps
 * for the server: the player is banned there, or its whitelist is on and they are on neither the
 * whitelist nor the operators, whom the game lets past it. The edge handed such a join on and saw
 * only the connection end, and a server's reporter tells of the login and nothing after. The game
 * checks its lists once it has verified the account and the reporter has told of the login, so on
 * a server that reports (its reporter told of its boot), a join that logged in, ended, never
 * reached the world and has no reason yet is read against the server's lists as they stand, a ban
 * first, as the game checks one first; one that never logged in, its account unverified or its
 * client gone first, is given no reason. A server with no reporter, a vanilla one, tells of
 * neither, so a join it was handed is read against its lists alone, and there an unverified
 * account kept out of a whitelisted server reads as the whitelist's refusal. It is read when the
 * edge says the join ended and again when the server's word of the login comes, whichever is last.
 *
 * Not for a join the edge turned away, which carries its own reason, nor for why a player left
 * once in (`server-events.ts`).
 */
import { type Queryable, schema } from '@blockly/db'
import { and, eq, inArray, isNotNull, isNull, notExists, or, sql } from 'drizzle-orm'
import { offlineUuid } from '../access/identity.ts'

const joins = schema.joins
const entries = schema.serverAccessEntries

/** The join's server has a reporter: it told of its boot. */
const reporting = sql`(select 1 from ${schema.serverReports} where ${schema.serverReports.serverId} = ${joins.serverId})`

/** What the game holds of a server's lists: an entry whose removal hasn't reached it still counts. */
const HELD = ['active', 'pending_remove'] as const

/** Sets the reason of join `id` where the game refused it for its whitelist or a ban. */
export async function noteRefusal(q: Queryable, id: string): Promise<void> {
  const [join] = await q
    .select({ serverId: joins.serverId, uuid: joins.playerUuid, name: joins.playerName })
    .from(joins)
    .where(
      and(
        eq(joins.id, id),
        isNotNull(joins.leftAt),
        isNotNull(joins.handedAt),
        isNull(joins.inWorldAt),
        isNull(joins.leftReason),
        // Logged in, on a server whose reporter would have said so.
        or(isNotNull(joins.loginAt), notExists(reporting)),
      ),
    )
  // The player's UUID is the client's own word: enough to explain a refusal, and without it there
  // is nobody to look for.
  if (join?.serverId == null || join.uuid === null) return
  // A server that doesn't check accounts keys a player, and its lists, by a UUID made from their
  // name rather than the account's UUID the client sends. One made from a name is never an
  // account's, so looking for both finds the player on either kind of server without asking which.
  const uuids = join.name === null ? [join.uuid] : [join.uuid, offlineUuid(join.name)]
  const reason = await refusalOf(q, join.serverId, uuids)
  if (reason !== null)
    await q
      .update(joins)
      .set({ leftReason: reason })
      .where(and(eq(joins.id, id), isNull(joins.leftReason)))
}

/** Whether the server's lists keep any of `uuids` out, and why; null where they let them in. */
async function refusalOf(q: Queryable, serverId: string, uuids: readonly string[]): Promise<string | null> {
  const listed = await q
    .select({ list: entries.list })
    .from(entries)
    .where(
      and(
        eq(entries.serverId, serverId),
        inArray(entries.playerUuid, [...uuids]),
        inArray(entries.state, HELD),
      ),
    )
  const on = new Set(listed.map((entry) => entry.list))
  if (on.has('ban')) return 'refused:banned'
  if (on.has('whitelist') || on.has('operator')) return null
  const [access] = await q
    .select({ whitelist: schema.serverAccess.whitelistEnabled })
    .from(schema.serverAccess)
    .where(eq(schema.serverAccess.serverId, serverId))
  return access?.whitelist === true ? 'refused:whitelist' : null
}
