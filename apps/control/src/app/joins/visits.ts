// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edge's half of each join (`VisitReport`), written into its row: the server the address
 * reaches, and how it reached it, resolved as the edge's routes are; the client's network as a
 * hash keyed to the server, as `known_addresses` keeps it; and every other column only while it is
 * empty, so a later half never overwrites what an earlier one said. `left_at` keeps the earliest.
 *
 * Not for the server's half: that is `server-events.ts`.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { VisitReport } from '@blockly/contracts/join-records'
import { type Queryable, schema } from '@blockly/db'
import { and, desc, eq, gt, lt, or, sql } from 'drizzle-orm'
import { keptFor } from '../../domain/server/kept-addresses.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { addressHash } from '../edge/known-addresses.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import type { SecretKeyring } from '../secrets.ts'
import { findLiveBySlug } from '../servers/persistence.ts'
import { addressOfSource, sourceOf } from './sources.ts'

const joins = schema.joins

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A player's UUID as the column takes it; null for one a client made up. */
export function uuidOf(given: string | undefined): string | null {
  const uuid = given === undefined ? '' : normalizeUuid(given)
  return UUID.test(uuid) ? uuid : null
}

/** The server an address reaches, and whose address it is; nothing for one no live server has. */
async function resolveAddress(
  q: Queryable,
  addressing: PlayAddressing,
  address: string,
): Promise<{ serverId: string | null; kind: 'own' | 'kept' | 'old_domain' | null }> {
  const slug = addressing.slugFor(address)
  const server = slug === null ? null : await findLiveBySlug(q, slug)
  if (server === null) return { serverId: null, kind: null }
  const label = address.split('.')[0] ?? ''
  const domain = addressing.domainFor(address)
  const old = addressing.domains().some((d) => d.alias && d.domain === domain)
  return { serverId: server.id, kind: keptFor(label) !== null ? 'kept' : old ? 'old_domain' : 'own' }
}

/** The columns a report may write, each only while it is empty. */
const FILLED = [
  'serverId',
  'edgeId',
  'edgeRegion',
  'addressKind',
  'protocol',
  'playerName',
  'playerUuid',
  'network',
  'source',
  'path',
  'pingedAt',
  'wakeAskedAt',
  'wakeOperationId',
  'readyAt',
  'handedAt',
  'leftReason',
  'pingedAfterAt',
  'bytesUp',
  'bytesDown',
] as const satisfies readonly (keyof typeof joins.$inferInsert)[]

/** The row a report writes, with the server and network it resolves to. */
async function rowOf(
  q: Queryable,
  deps: { addressing: PlayAddressing; ring: SecretKeyring },
  report: VisitReport,
): Promise<typeof joins.$inferInsert & Parameters<typeof adopt>[1]> {
  const address = report.address.trim().toLowerCase().replace(/\.$/, '')
  const { serverId, kind } = await resolveAddress(q, deps.addressing, address)
  const source = sourceOf(report.source)
  const at = (iso: string | undefined) => (iso === undefined ? null : new Date(iso))
  return {
    id: report.joinId,
    kind: report.phase === 'look' ? ('look' as const) : ('join' as const),
    serverId,
    edgeId: report.edgeId,
    edgeRegion: report.region,
    address,
    addressKind: kind,
    protocol: report.protocol ?? null,
    playerName: report.player?.name ?? null,
    playerUuid: uuidOf(report.player?.uuid),
    network:
      serverId === null || source === null ? null : addressHash(deps.ring, serverId, addressOfSource(source)),
    source,
    path: report.path ?? null,
    pingedAt: at(report.pingedAt),
    connectedAt: at(report.connectedAt) ?? at(report.pingedAt) ?? new Date(),
    wakeAskedAt: at(report.wakeAskedAt),
    wakeOperationId: report.wakeOperationId ?? null,
    readyAt: at(report.readyAt),
    handedAt: at(report.handedAt),
    leftAt: at(report.leftAt),
    leftReason: report.leftReason ?? null,
    pingedAfterAt: at(report.pingedAfterAt),
    bytesUp: report.bytesUp ?? null,
    bytesDown: report.bytesDown ?? null,
    detail: report.detail ?? {},
  }
}

/** Writes each report into its join's row. */
export async function recordVisits(
  q: Queryable,
  deps: { addressing: PlayAddressing; ring: SecretKeyring },
  reports: readonly VisitReport[],
): Promise<void> {
  for (const report of reports) {
    const row = await rowOf(q, deps, report)
    await adopt(q, row)
    const set: Record<string, unknown> = Object.fromEntries(
      FILLED.map((key) => [key, sql`coalesce(${joins[key]}, excluded.${sql.identifier(joins[key].name)})`]),
    )
    // A connection is never left before it was: the earliest word of its end stands.
    set.leftAt = sql`least(${joins.leftAt}, excluded.left_at)`
    set.detail = sql`${joins.detail} || excluded.detail`
    await q.insert(joins).values(row).onConflictDoUpdate({ target: joins.id, set })
  }
}

/** How far apart the edge's and the server's word of the same join may be. */
const SAME_JOIN_MS = 2 * MINUTE_MS

/**
 * Where the server reported a join before the edge did, its row is the edge's from now on: it
 * takes the edge's id, so both halves are one row. Found by source, else by the player's UUID or
 * name (`samePlayer`), near in time.
 */
async function adopt(
  q: Queryable,
  row: {
    id: string
    serverId: string | null
    source: string | null
    playerUuid: string | null
    playerName: string | null
    connectedAt: Date
  },
): Promise<void> {
  if (row.serverId === null) return
  const [own] = await q.select({ id: joins.id }).from(joins).where(eq(joins.id, row.id))
  if (own !== undefined) return
  const near = and(
    gt(joins.connectedAt, new Date(row.connectedAt.getTime() - SAME_JOIN_MS)),
    lt(joins.connectedAt, new Date(row.connectedAt.getTime() + SAME_JOIN_MS)),
  )
  const same = or(
    row.source === null ? undefined : eq(joins.source, row.source),
    samePlayer({ uuid: row.playerUuid, name: row.playerName }),
  )
  if (same === undefined) return
  const [orphan] = await q
    .select({ id: joins.id })
    .from(joins)
    .where(and(eq(joins.serverId, row.serverId), sql`${joins.detail}->>'edge' = 'missing'`, near, same))
    .orderBy(desc(joins.connectedAt))
    .limit(1)
  if (orphan === undefined) return
  // The server's word of when it began is later than the edge's: the edge's stands.
  await q
    .update(joins)
    .set({ id: row.id, connectedAt: row.connectedAt, detail: sql`${joins.detail} - 'edge'` })
    .where(eq(joins.id, orphan.id))
  // A signal already raised on it goes with it: nothing else names a join by its id.
  await q.update(schema.signals).set({ joinId: row.id }).where(eq(schema.signals.joinId, orphan.id))
}

/** The rows of the same player: their UUID, or their name in any case; undefined knowing neither. */
export function samePlayer(player: { uuid: string | null; name: string | null }) {
  return or(
    player.uuid === null ? undefined : eq(joins.playerUuid, player.uuid),
    player.name === null ? undefined : sql`lower(${joins.playerName}) = lower(${player.name})`,
  )
}
