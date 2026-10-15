// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether every edge holds a running server's route, so that it may read as running: a player
 * who joins the moment it does is let in, never closed by an edge that hasn't heard yet.
 *
 * An edge asks for its routes about once a second, naming the list it holds. When that is the
 * list it would be handed now, it holds every route the database named as the list's read began
 * (`edges.synced_to`). A server's `route_listed_at` is when a route list first named it running,
 * taken from the same clock, after the read that saw it, so it reads as running once every edge
 * seen lately is synced to at least that. With no edge seen lately, as where a deployment runs
 * none, nothing waits.
 *
 * Not for what an edge does with its routes, which is apps/edge's, or for building them
 * (`service.ts`).
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { type Db, type Queryable, schema } from '@blockly/db'
import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { EventBus } from '../ports/events.ts'

const { edges, minecraftServers: servers } = schema

/**
 * How long an edge counts after it last asked. It asks every second, so this is several missed
 * polls; an edge gone for good holds a new server back from reading as running for this long.
 */
export const EDGE_SEEN_MS = 10 * SECOND_MS

/**
 * How far every edge seen lately holds its routes: those of servers listed running up to then.
 * `everywhere` when no edge has been seen lately, so there is none to wait for.
 */
type Reach = Date | 'everywhere'

/** The database's own clock, which every time here is read from. */
export async function databaseNow(q: Queryable): Promise<Date> {
  // To the millisecond below, which only ever makes an edge's word cover a little less.
  const { rows } = await q.execute<{ ms: number }>(
    sql`select floor(extract(epoch from clock_timestamp()) * 1000)::float8 as ms`,
  )
  const ms = rows[0]?.ms
  if (ms === undefined) throw new Error('The database told no time')
  return new Date(ms)
}

async function reach(q: Queryable): Promise<Reach> {
  const [row] = await q
    .select({
      live: sql<number>`count(*)::int`,
      // An edge that has never said what it holds holds nothing yet.
      to: sql<Date | null>`min(coalesce(${edges.syncedTo}, 'epoch'::timestamptz))`.mapWith(edges.syncedTo),
    })
    .from(edges)
    .where(gt(edges.seenAt, sql`clock_timestamp() - make_interval(secs => ${EDGE_SEEN_MS / SECOND_MS})`))
  return !row || row.live === 0 || row.to === null ? 'everywhere' : row.to
}

/** Whether a running server listed at `listedAt` is held by every edge `reach` covers. */
const routed = (listedAt: Date | null, to: Reach): boolean =>
  to === 'everywhere' || (listedAt !== null && listedAt <= to)

/**
 * The status people are shown: running only once every edge holds the route; until then it is
 * still starting, as far as anyone joining can tell.
 */
export async function shownStatus<S extends string>(
  q: Queryable,
  serverId: string,
  status: S,
): Promise<S | 'starting'> {
  if (status !== 'running') return status
  const to = await reach(q)
  if (to === 'everywhere') return status
  const [row] = await q
    .select({ listedAt: servers.routeListedAt })
    .from(servers)
    .where(eq(servers.id, serverId))
  return routed(row?.listedAt ?? null, to) ? status : 'starting'
}

/** A route list just named these servers running: the first one to do so for each says when. */
export async function markListed(q: Queryable, serverIds: readonly string[]): Promise<void> {
  if (serverIds.length === 0) return
  // Read after the list's own read, so whatever reads from this time on sees them running too.
  await q
    .update(servers)
    .set({ routeListedAt: sql`clock_timestamp()` })
    .where(
      and(inArray(servers.id, [...serverIds]), eq(servers.status, 'running'), isNull(servers.routeListedAt)),
    )
}

/**
 * Edge `edgeId` asked for its routes. `syncedTo` is when the read of the list it holds began, where
 * it holds the list it would be handed now, else null. A server every edge now holds, and didn't
 * before, reads as running from here: its version moves, and its page is told.
 */
export async function seen(db: Db, events: EventBus, edgeId: string, syncedTo: Date | null): Promise<void> {
  if (syncedTo === null) {
    await db
      .insert(edges)
      .values({ edgeId, seenAt: sql`clock_timestamp()` })
      .onConflictDoUpdate({ target: edges.edgeId, set: { seenAt: sql`clock_timestamp()` } })
    return
  }
  await db.transaction(async (tx) => {
    // One edge at a time, so what each one's word covers is told exactly once.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('blockly:edges'))`)
    const before = await reach(tx)
    await tx
      .insert(edges)
      .values({ edgeId, syncedTo, seenAt: sql`clock_timestamp()` })
      .onConflictDoUpdate({ target: edges.edgeId, set: { syncedTo, seenAt: sql`clock_timestamp()` } })
    const after = await reach(tx)
    // Where every server read as running already, and still does, nothing changed for anyone.
    if (before === 'everywhere' || after === 'everywhere' || after <= before) return
    const now = await tx
      .update(servers)
      .set({ version: sql`${servers.version} + 1` })
      .where(
        and(
          eq(servers.status, 'running'),
          gt(servers.routeListedAt, before),
          lte(servers.routeListedAt, after),
        ),
      )
      .returning({ id: servers.id, ownerId: servers.ownerId, version: servers.version })
    for (const server of now)
      await events.publish(tx, {
        type: 'server_changed',
        serverId: server.id,
        ownerId: server.ownerId,
        status: 'running',
        version: server.version,
      })
  })
}
