// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the edge's route list is read from, and its fingerprint. The edge asks for its routes every
 * second and nearly always nothing has changed, so an ask reads at most one short row: the
 * database's time, the fingerprint and two flags; and none while the database has said nothing
 * changed (`EdgeService`, migration 0082's triggers, which cover every table read here). The
 * inputs themselves are read again only when the fingerprint moves, in one snapshot with the
 * fingerprint they then go by.
 *
 * The fingerprint is a digest of the very rows the input queries return, computed by the
 * database, so nothing can be read here that it leaves out. Revisions are never edited, so their
 * messages, and what they run, go by the revision a server names. Not for building the routes (`service.ts`), or for
 * what the flags lead to (`routed.ts`).
 */
import type { EdgeRoute } from '@blockly/contracts/edge'
import { type Db, type Queryable, schema } from '@blockly/db'
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { type Loader, type OtherVersions, otherVersionsOf } from '../../domain/revision/revision.ts'
import type { ServerStatus } from '../../domain/server/lifecycle.ts'
import { trialStops } from '../accounts/play-total.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import { motdsOf } from '../servers/persistence.ts'
import { playersMods, type RevisionMods } from './players-mods.ts'

const {
  accountStanding: standing,
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
  /** Servers whose open start boots: a resume given up on boots from its disk, as a plain boot does. */
  booting: Set<string>
  /** Servers stopped for their owner's free trial's hours, with the owner's plan (`trialOver`). */
  trials: Awaited<ReturnType<typeof trialStops>>
  /** The message of the day each asleep server's revision sets. */
  motds: Map<string, string>
  /** An operator's notice on each live server's owner, as written, by server (`accounts/notice.ts`). */
  notices: Map<string, string>
  /**
   * What each server's revision runs, by revision, for the revision it starts with and the one
   * its run booted: its release and server type, and of its mods
   * only those named like the Via plugins, which are all that decide which clients it takes.
   */
  plays: Map<string, Plays>
  /** What a player's game has to match, by the same revisions, for those whose players need any (`players-mods.ts`). */
  players: Map<string, NonNullable<EdgeRoute['mods']>>
}

/** A live server's binding, as far as its routes go. */
interface Binding {
  handle: RuntimeHandle | null
  proxyProtocol: boolean
  /** The revision its run booted. */
  revisionId: string | null
  /** Which of Cubepals' Via plugins that boot placed; null for a boot from before one said. */
  compat: string[] | null
  /** Its sleep kept its memory, so a wake resumes it (`wake-times.ts`'s way). */
  memoryKept: boolean
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
      memoryKept: sql<boolean>`${runtimes.memoryKeptAt} is not null`,
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

const bootingRows = (q: Queryable) =>
  q
    .select({ serverId: operations.serverId })
    .from(operations)
    .where(
      and(
        eq(operations.kind, 'start'),
        inArray(operations.status, ['queued', 'running']),
        sql`${operations.steps} @> '[{"step":"booting"}]'::jsonb`,
      ),
    )

/** The live servers whose owner has a notice on their account, with it. */
const noticeRows = (q: Queryable) =>
  q
    .select({ serverId: servers.id, notice: sql<string>`${standing.notice}` })
    .from(servers)
    .innerJoin(standing, eq(standing.userId, servers.ownerId))
    .where(and(isNull(servers.deletedAt), isNotNull(standing.notice)))

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
      loaderVersion: revisions.loaderVersion,
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
    rows.map(({ id, otherVersions, pack, loaderVersion, ...plays }) => [
      id,
      {
        ...plays,
        // Plain Minecraft on Mojang's own server runs no plugin, whatever it chose.
        otherVersions:
          pack || (plays.loader === 'vanilla' && loaderVersion === null)
            ? 'off'
            : otherVersionsOf({
                loader: plays.loader,
                settings: { otherVersions: otherVersions ?? undefined },
              }),
      },
    ]),
  )
}

/**
 * How many of a server's revisions are read back for its last change of mods: one further back,
 * behind this many changes of anything else, goes without its date.
 */
const MODS_HISTORY = 50

/**
 * What is read of each pin for `players-mods.ts`, and how much: the first jars of a revision, each
 * name, version and file cut to a few characters, and a few of its loaders. Names are an owner's
 * (an upload's own), and every live server's recent revisions are read whenever a route moves, so
 * nothing read here grows with what an owner writes.
 */
const MOST_PINS = 1000
const MOST_CHARS = 64
const MOST_LOADERS = 8

/** A revision's pins, as `RevisionMods['mods']`, each field cut to its most. */
const pinsOf = (column: SQLWrapper) => sql<RevisionMods['mods']>`(
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', left(p.m->>'name', ${sql.raw(String(MOST_CHARS))}),
    'versionLabel', left(p.m->>'versionLabel', ${sql.raw(String(MOST_CHARS))}),
    'environment', left(p.m->>'environment', 16),
    'file', left(coalesce(p.m->'source'->>'versionId', p.m->'source'->>'uploadId', ''), ${sql.raw(String(MOST_CHARS))}),
    'loaders', (
      select coalesce(jsonb_agg(left(l.tag, 32)), '[]'::jsonb)
      from (
        select t.tag from jsonb_array_elements_text(
          case when jsonb_typeof(p.m->'loaders') = 'array' then p.m->'loaders' else '[]'::jsonb end
        ) as t(tag) limit ${sql.raw(String(MOST_LOADERS))}
      ) l
    )
  ) order by p.at), '[]'::jsonb)
  from (
    select m, at from jsonb_array_elements(${column}) with ordinality as e(m, at)
    order by at limit ${sql.raw(String(MOST_PINS))}
  ) p
)`

/** A revision's pack, as `RevisionMods['modpack']`, each field cut to its most; null for none. */
const packOf = (column: SQLWrapper) => sql<RevisionMods['modpack']>`case when ${column} is null then null else
  jsonb_build_object(
    'name', left(${column}->>'name', ${sql.raw(String(MOST_CHARS))}),
    'versionLabel', left(${column}->>'versionLabel', ${sql.raw(String(MOST_CHARS))}),
    'versionId', left(${column}->>'versionId', ${sql.raw(String(MOST_CHARS))}),
    'environment', left(${column}->>'environment', 16)
  ) end`

/** What a player's game has to match to play the revisions `ids`, from each and those before it. */
async function playersOf(q: Queryable, ids: readonly string[]): Promise<RouteInputs['players']> {
  if (ids.length === 0) return new Map()
  const routed = await q
    .select({ id: revisions.id, serverId: revisions.serverId, number: revisions.number })
    .from(revisions)
    .where(inArray(revisions.id, [...ids]))
  if (routed.length === 0) return new Map()
  // Of each server, its revisions from as far back as its oldest routed one reads to its newest.
  const spans = new Map<string, { from: number; to: number }>()
  for (const { serverId, number } of routed) {
    const span = spans.get(serverId)
    spans.set(serverId, {
      from: Math.min(span?.from ?? number, number - MODS_HISTORY),
      to: Math.max(span?.to ?? number, number),
    })
  }
  const rows = await q
    .select({
      serverId: revisions.serverId,
      number: revisions.number,
      loader: revisions.loader,
      mods: pinsOf(revisions.mods),
      modpack: packOf(revisions.modpack),
      createdAt: revisions.createdAt,
    })
    .from(revisions)
    .where(
      or(
        ...[...spans].map(([serverId, { from, to }]) =>
          and(eq(revisions.serverId, serverId), gt(revisions.number, from), lte(revisions.number, to)),
        ),
      ),
    )
    .orderBy(desc(revisions.number))
  const players: RouteInputs['players'] = new Map()
  for (const { id, serverId, number } of routed) {
    const history = rows
      .filter((row) => row.serverId === serverId && row.number <= number)
      .slice(0, MODS_HISTORY)
      .map((row) => ({ ...row, loader: row.loader as Loader }))
    const theirs = playersMods(history)
    if (theirs !== undefined) players.set(id, theirs)
  }
  return players
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
      ${digestOf(comingBackRows(q))}, ${digestOf(bootingRows(q))}, ${digestOf(trialStops(q))},
      ${digestOf(pinRows(q))}, ${digestOf(noticeRows(q))})), 16),
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
      const routedRevisions = [
        ...live.flatMap((s) => (s.desiredRevisionId === null ? [] : [s.desiredRevisionId])),
        ...bindings.flatMap((b) => (b.revisionId === null ? [] : [b.revisionId])),
      ]
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
                memoryKept: b.memoryKept,
              },
            ]),
          ),
          comingBack: (await comingBackRows(tx)).map((row) => ({
            ...row,
            kind: row.kind as (typeof COMES_BACK)[number],
          })),
          booting: new Set((await bootingRows(tx)).map((row) => row.serverId)),
          trials: await trialStops(tx),
          motds: await motdsOf(
            tx,
            asleep.flatMap((s) => (s.desiredRevisionId === null ? [] : [s.desiredRevisionId])),
          ),
          notices: new Map((await noticeRows(tx)).map((row) => [row.serverId, row.notice])),
          plays: await playsOf(tx, routedRevisions),
          players: await playersOf(tx, routedRevisions),
        },
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
