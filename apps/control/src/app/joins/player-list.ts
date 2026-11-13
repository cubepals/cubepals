// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a server's own player list says of its joins: a second, coarser witness that a join got
 * in, for the servers no reporter plugin runs on. The presence pass reads the list about once a
 * minute (`operations/schedules/presence.ts`) and hands each reading here. A player on it has
 * their join marked as seen there (`detail.listedAt`, and `server_side` `console` where no
 * reporter told of it). A join handed over a pass or more before, still open, whose player isn't
 * on it is marked as not there (`detail.notListedAt`). Both keep when the list was read, up to a
 * pass after the fact, and neither touches a column the reporter writes: its `in_world_at` stays
 * the only time a join is measured by, and stands beside the list's when both spoke. A list that
 * couldn't be read says nothing, so nothing is marked.
 *
 * The edge tells of a join's end minutes after it, so a join is still open on its row for a while
 * after it ended: a mark made in that while is taken back once the end is known (`settleListed`).
 *
 * Not for reading the list, which the pass does; nor for who is online now (`servers/usage.ts`);
 * nor for what the marks say of how far a join got (`reached.ts`).
 */
import { floodgateName, isBedrockUuid } from '@blockly/contracts'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import type { ServerSide } from '@blockly/contracts/join-records'
import { type Queryable, schema } from '@blockly/db'
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { PresentPlayer } from '../servers/usage.ts'
import { LISTED_AT, listed, listSaid, NOT_LISTED_AT } from './reached.ts'

const joins = schema.joins

/** How often the pass reads a server's list: `presence-sync`'s schedule (`infra/pg/cron.ts`). */
const PASS_MS = MINUTE_MS
/**
 * How long after it connected a join is still looked for. One not in the world an hour on isn't
 * coming, and the bound keeps each reading's query to the server's last hour of joins.
 */
const LOOKED_FOR_MS = HOUR_MS

const NOBODY: ServerSide = 'not_reported'
const CONSOLE: ServerSide = 'console'

/** An open join as a reading looks at it. */
interface OpenJoin {
  id: string
  uuid: string | null
  name: string | null
  handedAt: Date | null
  inWorldAt: Date | null
  detail: Record<string, unknown>
}

/**
 * Whether the list's `player` is who `join` named: by UUID, or by name in any case, as a server's
 * own events are matched (`server-events.ts`), since a server that doesn't check accounts lists a
 * player under a UUID of its own. Floodgate lists a Bedrock player under the name it makes of
 * their gamertag, so the name the join gave is compared as Floodgate would write it too.
 */
function isListed(player: PresentPlayer, join: OpenJoin): boolean {
  if (join.uuid !== null && join.uuid === player.uuid) return true
  if (join.name === null) return false
  const name = player.name.toLowerCase()
  if (join.name.toLowerCase() === name) return true
  return isBedrockUuid(player.uuid) && floodgateName(join.name).toLowerCase() === name
}

/** A reading of a server's list: how many it counted online, and those of them it named. */
export interface ListReading {
  online: number
  players: readonly PresentPlayer[]
}

/** Which open joins a reading saw their player for, and which it looked for and didn't. */
function readingOf(
  open: readonly OpenJoin[],
  { online, players }: ListReading,
  at: Date,
): { seen: string[]; missing: string[] } {
  const seen = new Set<string>()
  const theirs = new Set<string>()
  // A list that counts more players than it names has someone on it nobody could read.
  let unplaced = players.length < online
  for (const player of players) {
    const rows = open.filter((row) => isListed(player, row))
    for (const row of rows) theirs.add(row.id)
    // A player is on a server once. Of two joins still open for them, a retry seconds after a
    // failed try, the one handed over last is the one on now: the same rule the reporter's events
    // are matched by. Where that one already got in, the older is left alone.
    const [latest] = rows
    if (latest === undefined) unplaced ||= isBedrockUuid(player.uuid)
    else if (latest.inWorldAt === null && listSaid(latest.detail).listedAt === null) seen.add(latest.id)
  }
  // A Bedrock player the reading could tie to no join may be any waiting join's, under a name
  // Floodgate made that the join's own doesn't give, and so may a player the list didn't name:
  // while one is on, no join is called absent.
  if (unplaced) return { seen: [...seen], missing: [] }
  const due = at.getTime() - PASS_MS
  const missing = open.filter((row) => {
    if (theirs.has(row.id) || row.inWorldAt !== null) return false
    // Nobody to look for; or handed over too lately to be in the world yet.
    if ((row.uuid === null && row.name === null) || (row.handedAt?.getTime() ?? at.getTime()) > due)
      return false
    const said = listSaid(row.detail)
    return said.listedAt === null && said.notListedAt === null
  })
  return { seen: [...seen], missing: missing.map((row) => row.id) }
}

const marked = (key: string, at: Date) => sql`${joins.detail} || ${JSON.stringify({ [key]: at })}::jsonb`

/**
 * Marks server `serverId`'s open joins with what its list, read at `at`, said of their players.
 * One read of the joins handed over in the last hour and still open, and a write only for a join
 * whose mark is new, which is once or twice in its life.
 */
export async function noteListed(
  q: Queryable,
  serverId: string,
  reading: ListReading,
  at: Date,
): Promise<void> {
  const open = await q
    .select({
      id: joins.id,
      uuid: joins.playerUuid,
      name: joins.playerName,
      handedAt: joins.handedAt,
      inWorldAt: joins.inWorldAt,
      detail: joins.detail,
    })
    .from(joins)
    .where(
      and(
        eq(joins.serverId, serverId),
        eq(joins.kind, 'join'),
        gt(joins.connectedAt, new Date(at.getTime() - LOOKED_FOR_MS)),
        isNotNull(joins.handedAt),
        isNull(joins.leftAt),
      ),
    )
    .orderBy(desc(joins.handedAt))
  const { seen, missing } = readingOf(open, reading, at)
  // Each write looks again at what the read saw: the join may have ended in between.
  if (seen.length > 0)
    await q
      .update(joins)
      .set({
        detail: marked(LISTED_AT, at),
        serverSide: sql`case when ${joins.serverSide} = ${NOBODY} then ${CONSOLE} else ${joins.serverSide} end`,
      })
      .where(and(inArray(joins.id, seen), isNull(joins.leftAt)))
  if (missing.length > 0)
    await q
      .update(joins)
      .set({ detail: marked(NOT_LISTED_AT, at) })
      .where(and(inArray(joins.id, missing), isNull(joins.leftAt), sql`not ${listed}`))
}

const late = (key: string) => sql`(${joins.detail} ->> ${key})::timestamptz > ${joins.leftAt}`

/**
 * Join `id`'s end is known: a mark its server's list made after it had ended was never about this
 * join, which was open only on its row, and goes. The player seen was on a later join, or the one
 * missed had already left. A join the list alone told of is back to nobody having told of it.
 */
export async function settleListed(q: Queryable, id: string): Promise<void> {
  await q
    .update(joins)
    .set({
      detail: sql`${joins.detail} - array(select key from unnest(array[${LISTED_AT}, ${NOT_LISTED_AT}]::text[]) as key
        where (${joins.detail} ->> key)::timestamptz > ${joins.leftAt})`,
      serverSide: sql`case when ${joins.serverSide} = ${CONSOLE} and ${late(LISTED_AT)} then ${NOBODY} else ${joins.serverSide} end`,
    })
    .where(and(eq(joins.id, id), sql`(${late(LISTED_AT)} or ${late(NOT_LISTED_AT)})`))
}
