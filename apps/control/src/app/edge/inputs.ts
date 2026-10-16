// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the edge's route list is read from, and its fingerprint. The edge asks for its routes every
 * second and nearly always nothing has changed, so each ask reads one short row: the database's
 * time, the fingerprint and two flags. The inputs themselves are read again only when the
 * fingerprint moves, in one snapshot with the fingerprint they then go by.
 *
 * The fingerprint is a digest of the very rows the input queries return, computed by the
 * database, so nothing can be read here that it leaves out. Revisions are never edited, so their
 * messages, and what they run, go by the revision a server names. Not for building the routes (`service.ts`), or for
 * what the flags lead to (`routed.ts`).
 */
import { type Db, type Queryable, schema } from '@blockly/db'
import { and, inArray, isNull, type SQL, type SQLWrapper, sql } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { type Loader, type OtherVersions, otherVersionsOf } from '../../domain/revision/revision.ts'
import type { ServerStatus } from '../../domain/server/lifecycle.ts'
import { dailyStops } from '../accounts/play-today.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import { motdsOf } from '../servers/persistence.ts'

const {
  compatPlugins,
  minecraftServers: servers,
  serverRuntimes: runtimes,
  serverOperations: operations,
  serverRevisions: revisions,
} = schema

/**
 * The kinds of operation that bring a server back by themselves: a running one is restarting, and
 * one whose world comes back from rest (`unstore`) is waking.
 */
const COMES_BACK = ['restart', 'restore', 'relocate', 'unstore'] as const

/** Of a live server, what its routes say. */
export interface RouteServer {
  id: string
  slug: string
  status: ServerStatus
  name: string
  icon: string | null
  ownIcon: string | null
  desiredRevisionId: string | null
}

export interface RouteInputs {
  servers: RouteServer[]
  /** Each live server's binding to a runtime this deployment runs, by server. */
  bindings: Map<string, Binding>
  /** Open operations that bring a server back by themselves, and whether it was running. */
  comingBack: Array<{ serverId: string; kind: (typeof COMES_BACK)[number]; running: boolean }>
  stops: Array<{ id: string; zone: string | null; stoppedAt: Date | null }>
  /** The message of the day each asleep server's revision sets. */
  motds: Map<string, string>
  /**
   * What each server's revision runs, by revision, for the revision it starts with and the one
   * its run booted: its release and server type, and of its mods
   * only those named like the Via plugins, which are all that decide which clients it takes.
   */
  plays: Map<string, Plays>
}

/** A live server's binding, as far as its routes go. */
interface Binding {
  handle: RuntimeHandle | null
  proxyProtocol: boolean
  /** The revision its run booted. */
  revisionId: string | null
  /** Which of Cubepals' Via plugins that boot placed; null for a boot from before one said. */
  compat: string[] | null
}

/** What a revision runs, as far as which clients it takes. */
interface Plays {
  gameVersion: string
  loader: Loader
  mods: PinnedMod[]
  /** Which other versions' players Cubepals' own Via plugins let in; off for a pack server. */
  otherVersions: OtherVersions
  /** The Via plugins pinned for its release (`app/compat/`), which its next boot can place. */
  pinned: string[]
}

export interface Fingerprint {
  /** The database's time as the read began: every route version is read from its clock. */
  from: Date
  digest: string
  /** Whether a running server still waits to be told every edge holds it (`routed.ts`). */
  unrouted: boolean
  /** Whether a running server has yet to be named running by a route list (`markListed`). */
  unlisted: boolean
}

const serverRows = (q: Queryable) =>
  q
    .select({
      id: servers.id,
      slug: servers.slug,
      status: servers.status,
      name: servers.name,
      icon: servers.icon,
      ownIcon: servers.ownIcon,
      desiredRevisionId: servers.desiredRevisionId,
    })
    .from(servers)
    .where(isNull(servers.deletedAt))

/** Bindings to runtimes elsewhere are left out: their handles mean nothing here. */
const bindingRows = (q: Queryable, providers: readonly string[]) =>
  q
    .select({
      serverId: runtimes.serverId,
      handle: runtimes.handle,
      proxyProtocol: sql<boolean>`coalesce((${runtimes.applied}->>'proxyProtocol')::boolean, false)`,
      revisionId: sql<string | null>`${runtimes.applied}->>'revisionId'`,
      compat: sql<string[] | null>`${runtimes.applied}->'compat'`,
    })
    .from(runtimes)
    .where(
      and(
        inArray(runtimes.provider, [...providers]),
        sql`${runtimes.serverId} in (select ${servers.id} from ${servers} where ${servers.deletedAt} is null)`,
      ),
    )

const comingBackRows = (q: Queryable) =>
  q
    .select({
      serverId: operations.serverId,
      kind: operations.kind,
      running: sql<boolean>`coalesce((${operations.input}->>'running')::boolean, false)`,
    })
    .from(operations)
    .where(and(inArray(operations.kind, [...COMES_BACK]), inArray(operations.status, ['queued', 'running'])))

/** Which Via plugins are pinned for which release: a pin or its removal moves what a next boot places. */
const pinRows = (q: Queryable) =>
  q.select({ gameVersion: compatPlugins.gameVersion, projectId: compatPlugins.projectId }).from(compatPlugins)

/** What the revisions `ids` run, as `RouteInputs.plays` holds it. */
async function playsOf(q: Queryable, ids: readonly string[]): Promise<RouteInputs['plays']> {
  if (ids.length === 0) return new Map()
  const rows = await q
    .select({
      id: revisions.id,
      gameVersion: revisions.gameVersion,
      loader: revisions.loader,
      otherVersions: sql<OtherVersions | null>`${revisions.settings}->>'otherVersions'`,
      pack: sql<boolean>`${revisions.modpack} is not null`,
      pinned: sql<
        string[]
      >`array(select ${compatPlugins.projectId} from ${compatPlugins} where ${compatPlugins.gameVersion} = ${revisions.gameVersion})`,
      mods: sql<
        PinnedMod[]
      >`jsonb_path_query_array(${revisions.mods}, '$[*] ? (@.name like_regex "^via" flag "i")')`,
    })
    .from(revisions)
    .where(inArray(revisions.id, [...ids]))
  return new Map(
    rows.map(({ id, otherVersions, pack, ...plays }) => [
      id,
      {
        ...plays,
        otherVersions: pack ? 'off' : otherVersionsOf({ otherVersions: otherVersions ?? undefined }),
      },
    ]),
  )
}

/** The rows of `query`, digested in a fixed order; an empty one digests to its place alone. */
const digestOf = (query: SQLWrapper): SQL =>
  sql`coalesce((select string_agg(t::text, ';' order by t::text) from (${query}) t), '')`

/** The fingerprint, in one row of one column: what is read every second is kept short. */
export async function fingerprint(q: Queryable, providers: readonly string[]): Promise<Fingerprint> {
  const waiting = (column: SQL) =>
    sql`exists (select 1 from ${servers} where ${servers.status} = 'running' and ${column} is null and ${servers.deletedAt} is null)::int`
  const { rows } = await q.execute<{ v: string }>(sql`select concat_ws(' ',
    floor(extract(epoch from statement_timestamp()) * 1000)::bigint,
    left(md5(concat_ws('|', ${digestOf(serverRows(q))}, ${digestOf(bindingRows(q, providers))},
      ${digestOf(comingBackRows(q))}, ${digestOf(dailyStops(q))}, ${digestOf(pinRows(q))})), 16),
    ${waiting(sql`${servers.routedAt}`)},
    ${waiting(sql`${servers.routeListedAt}`)}) as v`)
  const [ms, digest, unrouted, unlisted] = (rows[0]?.v ?? '').split(' ')
  if (ms === undefined || digest === undefined) throw new Error('The database told no fingerprint')
  return { from: new Date(Number(ms)), digest, unrouted: unrouted === '1', unlisted: unlisted === '1' }
}

/** The inputs, with the fingerprint of these very rows: both are read in one snapshot. */
export async function readInputs(
  db: Db,
  providers: readonly string[],
): Promise<{ fingerprint: Fingerprint; inputs: RouteInputs }> {
  return db.transaction(
    async (tx) => {
      const print = await fingerprint(tx, providers)
      const live = await serverRows(tx)
      const bindings = await bindingRows(tx, providers)
      const asleep = live.filter((s) => s.status !== 'running' && s.desiredRevisionId !== null)
      return {
        fingerprint: print,
        inputs: {
          servers: live,
          bindings: new Map(
            bindings.map((b) => [
              b.serverId,
              {
                handle: b.handle as RuntimeHandle | null,
                proxyProtocol: b.proxyProtocol,
                revisionId: b.revisionId,
                compat: b.compat,
              },
            ]),
          ),
          comingBack: (await comingBackRows(tx)).map((row) => ({
            ...row,
            kind: row.kind as (typeof COMES_BACK)[number],
          })),
          stops: await dailyStops(tx),
          motds: await motdsOf(
            tx,
            asleep.flatMap((s) => (s.desiredRevisionId === null ? [] : [s.desiredRevisionId])),
          ),
          plays: await playsOf(tx, [
            ...live.flatMap((s) => (s.desiredRevisionId === null ? [] : [s.desiredRevisionId])),
            ...bindings.flatMap((b) => (b.revisionId === null ? [] : [b.revisionId])),
          ]),
        },
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
