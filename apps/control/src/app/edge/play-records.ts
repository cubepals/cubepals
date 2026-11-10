// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `play-records`: the play names' own A records, for servers in a region the edge has an address
 * of its own in (PLAY_IPV4_BY_REGION). The wildcard `*.<play domain>` holds one address, which Fly
 * may announce from one region only; a name with a record of its own beats the wildcard, so a
 * player joining a server in another region enters Fly in that server's region rather than
 * crossing to the wildcard's and back.
 *
 * Each pass makes the zone hold exactly what is wanted: one record per name the edge routes to a
 * server (`routedAddresses`) whose region has an address, at that address. A server is wanted from
 * the moment it is made until it goes to the trash or is purged; a stored one keeps its records,
 * since a join wakes it at the same name. Its region is where its compute is placed, or, before
 * any is, the region it was made in. Only records this deployment marked as its own are listed or
 * changed (`ports/play-records.ts`), never the wildcard. A name that has none yet, or one being
 * changed, is still reached through the wildcard, so nothing waits on a pass: not making a server,
 * nor starting one.
 *
 * Not for the edge's routes (`service.ts`), which say where a name goes once a join arrives.
 */
import { type Db, schema } from '@blockly/db'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import type { DeploymentCapabilities } from '../capabilities.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import type { PlayRecord } from '../ports/play-records.ts'
import { routedAddresses } from './service.ts'

const servers = schema.minecraftServers
const runtimes = schema.serverRuntimes

/**
 * The most records one pass writes or removes; the rest wait for the next, a minute on. It keeps a
 * pass within the zone's API rate when a region's address is first set, with its servers already
 * there.
 */
export const PLAY_RECORDS_PER_PASS = 100

/** A live server's slug and the region it is in. */
export interface PlacedServer {
  slug: string
  regionKey: string
}

/** What a pass changes, so the zone holds what is wanted. */
export interface RecordChanges {
  create: { name: string; ipv4: string }[]
  update: PlayRecord[]
  remove: PlayRecord[]
}

/** Each name wanted, at its server's region's address; a server in a region with none has none. */
export function wantedRecords(
  placed: readonly PlacedServer[],
  namesOf: (slug: string) => readonly string[],
  regionIpv4: Readonly<Record<string, string>>,
): Map<string, string> {
  const wanted = new Map<string, string>()
  for (const server of placed) {
    const ipv4 = regionIpv4[server.regionKey]
    if (ipv4 === undefined) continue
    for (const name of namesOf(server.slug)) wanted.set(name.toLowerCase(), ipv4)
  }
  return wanted
}

/**
 * What turns the records held into those wanted: a name not wanted, or held twice, is removed; one
 * at another address is changed in place; a name with none is made.
 */
export function recordChanges(
  wanted: ReadonlyMap<string, string>,
  held: readonly PlayRecord[],
): RecordChanges {
  const changes: RecordChanges = { create: [], update: [], remove: [] }
  const kept = new Set<string>()
  for (const record of held) {
    const name = record.name.toLowerCase()
    const ipv4 = wanted.get(name)
    if (ipv4 === undefined || kept.has(name)) {
      changes.remove.push(record)
      continue
    }
    kept.add(name)
    if (record.ipv4 !== ipv4) changes.update.push({ ...record, name, ipv4 })
  }
  for (const [name, ipv4] of wanted) if (!kept.has(name)) changes.create.push({ name, ipv4 })
  return changes
}

/** Keeps the play names' own records (see the top of this file). */
export class PlayRecordKeeper {
  readonly #db: Db
  readonly #addressing: PlayAddressing
  readonly #kept: NonNullable<DeploymentCapabilities['playRecords']> | null

  constructor(deps: {
    db: Db
    addressing: PlayAddressing
    capabilities: Pick<DeploymentCapabilities, 'playRecords'>
  }) {
    this.#db = deps.db
    this.#addressing = deps.addressing
    this.#kept = deps.capabilities.playRecords ?? null
  }

  /**
   * `play-records`: one pass. How many records it wrote or removed. A change the zone refused
   * fails the pass, after the others are tried; the next pass tries it again.
   */
  async keep(): Promise<number> {
    if (this.#kept === null) return 0
    const { records, regionIpv4 } = this.#kept
    const wanted = wantedRecords(
      await this.#placed(),
      (slug) => routedAddresses(this.#addressing, slug).map(({ address }) => address.hostname),
      regionIpv4,
    )
    const { create, update, remove } = recordChanges(wanted, await records.list())
    // Removed first: a name moving between servers frees its record before it is made again.
    const work = [
      ...remove.map((record) => () => records.remove(record.id)),
      ...update.map((record) => () => records.update(record)),
      ...create.map((record) => () => records.create(record.name, record.ipv4)),
    ].slice(0, PLAY_RECORDS_PER_PASS)
    const refused: unknown[] = []
    for (const change of work) await change().catch((error: unknown) => refused.push(error))
    if (refused.length > 0)
      throw new Error(`The zone refused ${refused.length} of ${work.length} changes to play records`, {
        cause: refused[0],
      })
    return work.length
  }

  /** Every server neither in the trash nor purged, by the region its compute is in. */
  async #placed(): Promise<PlacedServer[]> {
    return this.#db
      .select({
        slug: servers.slug,
        regionKey: sql<string>`coalesce(${runtimes.placementRegionKey}, ${servers.regionKey})`,
      })
      .from(servers)
      .leftJoin(runtimes, eq(runtimes.serverId, servers.id))
      .where(and(isNull(servers.deletedAt), ne(servers.status, 'purged')))
  }
}
