// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The game server's half of each join, from its reporter plugin, matched to the row the edge began:
 * by the client's `ip:port` where the server knew it, which is the edge's own `source` on a server
 * that reads a PROXY header; else by the player's UUID on a join the edge handed over moments
 * before, or one this server already reported on; else a row of its own, saying the edge's half is
 * missing. A `boot` keeps the server's latest word on what it runs. A login told of after the edge
 * said the join ended may show the game turned it away for its own lists (`refusals.ts`).
 *
 * Not for the edge's half: that is `visits.ts`.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { ServerJoinEvent } from '@blockly/contracts/join-records'
import { type Queryable, schema } from '@blockly/db'
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { joinCompleted } from '../platform/telemetry.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import { findServer } from '../servers/persistence.ts'
import { noteRefusal } from './refusals.ts'
import { sourceOf } from './sources.ts'
import { samePlayer, uuidOf } from './visits.ts'

const joins = schema.joins

/**
 * How soon after the edge hands a join over the server's first word of it comes, at the most; and
 * how long after the edge's word that it ended the server's may still come.
 */
const HANDED_WITHIN_MS = 2 * MINUTE_MS

/** Which column each kind of event fills. */
const MOMENTS = {
  login: 'loginAt',
  configure_started: 'configureStartedAt',
  configured: 'configuredAt',
  in_world: 'inWorldAt',
  left: 'leftAt',
} as const satisfies Record<
  Exclude<ServerJoinEvent['kind'], 'boot' | 'removed'>,
  keyof typeof joins.$inferInsert
>

/** Writes a server's events, in the order they happened; the joins they went on. */
export async function recordServerEvents(
  q: Queryable,
  addressing: PlayAddressing,
  serverId: string,
  events: readonly ServerJoinEvent[],
): Promise<string[]> {
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const touched: string[] = []
  for (const event of ordered) {
    if (event.kind === 'boot') await recordBoot(q, serverId, event)
    // Stop cheaters' own (`stop-cheaters/service.ts`): no moment of a join.
    else if (event.kind === 'removed') continue
    else touched.push(...(await recordMoment(q, addressing, serverId, { ...event, kind: event.kind })))
  }
  return touched
}

async function recordBoot(q: Queryable, serverId: string, event: ServerJoinEvent): Promise<void> {
  const row = { serverId, reportedAt: new Date(event.at), detail: event.detail ?? {} }
  await q
    .insert(schema.serverReports)
    .values(row)
    .onConflictDoUpdate({
      target: schema.serverReports.serverId,
      set: { reportedAt: row.reportedAt, detail: row.detail },
    })
}

async function recordMoment(
  q: Queryable,
  addressing: PlayAddressing,
  serverId: string,
  event: ServerJoinEvent & { kind: keyof typeof MOMENTS },
): Promise<string[]> {
  const at = new Date(event.at)
  const uuid = uuidOf(event.uuid)
  const source = sourceOf(event.address)
  const id =
    (await matching(q, serverId, source, { uuid, name: event.name ?? null }, at, event.kind === 'login')) ??
    (await begun(q, addressing, serverId, source, at))
  if (id === null) return []
  const column = joins[MOMENTS[event.kind]]
  const [before] =
    event.kind === 'in_world'
      ? await q
          .select({
            inWorldAt: joins.inWorldAt,
            connectedAt: joins.connectedAt,
            path: joins.path,
            edgeRegion: joins.edgeRegion,
            detail: joins.detail,
          })
          .from(joins)
          .where(eq(joins.id, id))
      : []
  await q
    .update(joins)
    .set({
      serverSide: 'reported',
      [MOMENTS[event.kind]]:
        event.kind === 'left'
          ? sql`least(${column}, ${at.toISOString()}::timestamptz)`
          : sql`coalesce(${column}, ${at.toISOString()}::timestamptz)`,
      playerUuid: sql`coalesce(${joins.playerUuid}, ${uuid}::uuid)`,
      playerName: sql`coalesce(${joins.playerName}, ${event.name ?? null})`,
      ...(event.kind === 'left'
        ? { leftReason: sql`coalesce(${joins.leftReason}, ${event.reason ?? null})` }
        : {}),
      ...(event.kind === 'in_world' && event.tick ? { tick: event.tick } : {}),
    })
    .where(eq(joins.id, id))
  // The edge may have told of its end already: where the game turned it away for its own lists,
  // that is why.
  if (event.kind === 'login') await noteRefusal(q, id)
  // Timed once, from the edge's handshake; a join the edge said nothing of has no handshake.
  if (before !== undefined && before.inWorldAt === null && before.detail.edge !== 'missing')
    joinCompleted(before.path, before.edgeRegion, at.getTime() - before.connectedAt.getTime())
  return [id]
}

/**
 * The join an event belongs to: by its source, else by the player, their UUID or their name; null
 * for none. A server that doesn't check accounts gives a player its own UUID, not the one the
 * client told the edge, so the name, which no two players on a server share at once, matches too.
 */
async function matching(
  q: Queryable,
  serverId: string,
  source: string | null,
  player: { uuid: string | null; name: string | null },
  at: Date,
  /** A login begins a join: it never follows one the server already told of. */
  begins: boolean,
): Promise<string | null> {
  const ours = and(eq(joins.serverId, serverId), eq(joins.kind, 'join'))
  // The edge's close may come first: its leaving is no reason to look past it. A connection's
  // source is its own while it is kept, so it matches whether or not the join has ended.
  if (source !== null) {
    const [bySource] = await q
      .select({ id: joins.id })
      .from(joins)
      .where(and(ours, eq(joins.source, source)))
      .orderBy(desc(joins.connectedAt))
      .limit(1)
    if (bySource !== undefined) return bySource.id
  }
  const same = samePlayer(player)
  if (same === undefined) return null
  const handed = sql`coalesce(${joins.handedAt}, ${joins.connectedAt})`
  const [byPlayer] = await q
    .select({ id: joins.id })
    .from(joins)
    .where(
      and(
        ours,
        // Still on, or left moments before the server's word of it came.
        or(isNull(joins.leftAt), gt(joins.leftAt, new Date(at.getTime() - HANDED_WITHIN_MS))),
        same,
        // Handed over moments before; or, after its login, a join the server already told of.
        begins
          ? gt(handed, new Date(at.getTime() - HANDED_WITHIN_MS))
          : or(gt(handed, new Date(at.getTime() - HANDED_WITHIN_MS)), isNotNull(joins.loginAt)),
      ),
    )
    .orderBy(desc(handed))
    .limit(1)
  return byPlayer?.id ?? null
}

/** A row for a join the edge said nothing of, at the server's own address; null for no server. */
async function begun(
  q: Queryable,
  addressing: PlayAddressing,
  serverId: string,
  source: string | null,
  at: Date,
): Promise<string | null> {
  const server = await findServer(q, serverId)
  if (server === null) return null
  const id = crypto.randomUUID()
  await q.insert(joins).values({
    id,
    kind: 'join',
    serverId,
    address: addressing.primary(server.slug).hostname,
    addressKind: 'own',
    source,
    connectedAt: at,
    detail: { edge: 'missing' },
  })
  return id
}
