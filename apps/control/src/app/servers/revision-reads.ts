// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads of a revision that take only the columns the caller uses. A revision's mods, carried files
 * and modpack are the largest rows in the database, and most readers want a game version, the
 * settings or a mod list. `persistence.ts` keeps the whole row (`loadRevision`), for what boots a
 * server; the history page's comparison reads files by digest and mods by their identity
 * (`ChangeFacts`) rather than the files and mods themselves. Not for writing revisions.
 */
import { type Queryable, schema } from '@blockly/db'
import { desc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import type { ChangeFacts, ServerRevision } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { runsOf } from '../revisions/caps.ts'

const revisions = schema.serverRevisions

/** A pack pinned before `environment` and `icon` existed reads as it would have: for everyone, with no picture. */
const packOf = (pack: (typeof revisions.$inferSelect)['modpack']): PinnedModpack | null =>
  pack === null ? null : { environment: 'both', icon: null, ...pack }

const columns = {
  id: revisions.id,
  serverId: revisions.serverId,
  number: revisions.number,
  gameVersion: revisions.gameVersion,
  loader: revisions.loader,
  loaderVersion: revisions.loaderVersion,
  settings: revisions.settings,
  mods: revisions.mods,
  modpack: revisions.modpack,
  files: revisions.files,
  acknowledgedRevoked: revisions.acknowledgedRevoked,
  reason: revisions.reason,
  basedOnRevisionId: revisions.basedOnRevisionId,
  createdBy: revisions.createdBy,
} satisfies Record<keyof ServerRevision, unknown>

/** A revision without its carried files, which only what boots a server reads. */
export const WITHOUT_FILES = [
  'id',
  'serverId',
  'number',
  'gameVersion',
  'loader',
  'loaderVersion',
  'settings',
  'mods',
  'modpack',
  'acknowledgedRevoked',
  'reason',
  'basedOnRevisionId',
  'createdBy',
] as const satisfies ReadonlyArray<keyof ServerRevision>

/** Only `fields` of a revision are selected, so only they cross the wire. */
export async function loadRevisionFields<K extends keyof ServerRevision>(
  q: Queryable,
  id: string,
  fields: readonly K[],
): Promise<Pick<ServerRevision, K>> {
  const [row] = await q
    .select(Object.fromEntries(fields.map((field) => [field, columns[field]])))
    .from(revisions)
    .where(eq(revisions.id, id))
  if (!row) throw new Error(`Revision ${id} is missing`)
  const fields_ = row as Record<string, unknown>
  if ('modpack' in fields_)
    fields_.modpack = packOf(row.modpack as (typeof revisions.$inferSelect)['modpack'])
  return fields_ as Pick<ServerRevision, K>
}

/** A jsonb value built in SQL, which the driver has already parsed. */
const json = <T>(value: SQL) => value as SQL<T>

/** The mods as `describeChanges` reads them, built in Postgres: each by its identity, name, kinds and digest. */
const modFacts = json<
  ChangeFacts['mods']
>(sql`(select coalesce(jsonb_agg(jsonb_build_object('source', m->'source',
    'name', m->'name', 'loaders', m->'loaders', 'artifact', jsonb_build_object('sha512', m->'artifact'->'sha512'))
    order by n), '[]'::jsonb) from jsonb_array_elements(${revisions.mods}) with ordinality as e(m, n))`)

/** The rest of the facts `describeChanges` reads: files by digest and the pack by name. */
const otherFacts = {
  gameVersion: revisions.gameVersion,
  loader: revisions.loader,
  loaderVersion: revisions.loaderVersion,
  settings: revisions.settings,
  modpack: json<ChangeFacts['modpack']>(sql`case when ${revisions.modpack} is null then null else
    jsonb_build_object('catalog', ${revisions.modpack}->'catalog', 'versionId', ${revisions.modpack}->'versionId',
      'name', ${revisions.modpack}->'name', 'versionLabel', ${revisions.modpack}->'versionLabel') end`),
  files: json<ChangeFacts['files']>(sql`(select coalesce(jsonb_agg(jsonb_build_object('path', f->>'path',
      'content', encode(sha256(convert_to(f->>'content', 'UTF8')), 'hex')) order by n), '[]'::jsonb)
      from jsonb_array_elements(${revisions.files}) with ordinality as e(f, n))`),
}

/** One revision as `describeChanges` compares it. */
export async function loadChangeFacts(q: Queryable, id: string): Promise<ChangeFacts> {
  const [row] = await q
    .select({ ...otherFacts, mods: modFacts })
    .from(revisions)
    .where(eq(revisions.id, id))
  if (!row) throw new Error(`Revision ${id} is missing`)
  return row
}

export type HistoryEntry = ChangeFacts &
  Pick<ServerRevision, 'id' | 'number' | 'reason' | 'createdBy'> & { createdAt: Date }

/**
 * A server's revisions, newest first, each as `describeChanges` compares it with when it was made,
 * and the revision it should run as the same. Most revisions change settings and leave the mods
 * alone, so the mods are read once for each list that differs, found by a digest of the list.
 */
export async function revisionHistory(
  q: Queryable,
  serverId: string,
  desiredId: string,
  limit: number,
): Promise<{ desired: ChangeFacts; entries: HistoryEntry[] }> {
  const modsKey = sql<string>`md5(${revisions.mods}::text)`
  const listed = await q
    .select({
      ...otherFacts,
      id: revisions.id,
      number: revisions.number,
      reason: revisions.reason,
      createdBy: revisions.createdBy,
      createdAt: revisions.createdAt,
      modsKey,
    })
    .from(revisions)
    .where(eq(revisions.serverId, serverId))
    .orderBy(desc(revisions.number))
    .limit(limit)
  const [outside] = listed.some((row) => row.id === desiredId)
    ? []
    : await q
        .select({ ...otherFacts, id: revisions.id, modsKey })
        .from(revisions)
        .where(eq(revisions.id, desiredId))
  const desiredRow = listed.find((row) => row.id === desiredId) ?? outside
  if (desiredRow === undefined) throw new Error(`Revision ${desiredId} is missing`)
  const sample = new Map<string, string>()
  for (const row of [...listed, desiredRow]) if (!sample.has(row.modsKey)) sample.set(row.modsKey, row.id)
  const read = await q
    .select({ id: revisions.id, mods: modFacts })
    .from(revisions)
    .where(inArray(revisions.id, [...sample.values()]))
  const byId = new Map(read.map((row) => [row.id, row.mods]))
  const modsOf = (key: string) => byId.get(sample.get(key) ?? '') ?? []
  const factsOf = <R extends { modsKey: string }>({ modsKey: key, ...row }: R) => ({
    ...row,
    mods: modsOf(key),
  })
  return {
    desired: factsOf(desiredRow),
    entries: listed.map((row) => ({ ...factsOf(row), reason: row.reason as ServerRevision['reason'] })),
  }
}

/**
 * What a server's page shows of what it plays: the mods by name only, which is all joining asks of
 * them, with the loaders each is for, which say whether plain Minecraft runs on Paper (`runsOnPaper`).
 */
export type RevisionCard = Pick<
  ServerRevision,
  'id' | 'gameVersion' | 'loader' | 'loaderVersion' | 'settings' | 'modpack'
> & { mods: Array<Pick<PinnedMod, 'source' | 'name' | 'loaders'>> }

export async function loadRevisionCard(q: Queryable, id: string): Promise<RevisionCard> {
  const [row] = await q
    .select({
      id: revisions.id,
      gameVersion: revisions.gameVersion,
      loader: revisions.loader,
      loaderVersion: revisions.loaderVersion,
      settings: revisions.settings,
      modpack: revisions.modpack,
      mods: json<RevisionCard['mods']>(
        sql`(select coalesce(jsonb_agg(jsonb_build_object('source', m->'source', 'name', m->'name', 'loaders', m->'loaders') order by n), '[]'::jsonb)
          from jsonb_array_elements(${revisions.mods}) with ordinality as e(m, n))`,
      ),
    })
    .from(revisions)
    .where(eq(revisions.id, id))
  if (!row) throw new Error(`Revision ${id} is missing`)
  return { ...row, modpack: packOf(row.modpack) }
}

/** What a list of revisions shows of each: which one it is, what it plays on, and the names of its mods. */
export interface RevisionSummary {
  id: string
  number: number
  gameVersion: string
  loader: ServerRevision['loader']
  modNames: string[]
}

/** The summaries of `ids`, by revision, in one read. */
export async function summariesOf(
  q: Queryable,
  ids: readonly string[],
): Promise<Map<string, RevisionSummary>> {
  if (ids.length === 0) return new Map()
  const rows = await q
    .select({
      id: revisions.id,
      number: revisions.number,
      gameVersion: revisions.gameVersion,
      loader: revisions.loader,
      modNames: json<string[]>(
        sql`(select coalesce(jsonb_agg(m->>'name' order by n), '[]'::jsonb) from jsonb_array_elements(${revisions.mods}) with ordinality as e(m, n))`,
      ),
    })
    .from(revisions)
    .where(inArray(revisions.id, [...ids]))
  return new Map(rows.map((row) => [row.id, row]))
}

/** What a server's desired revision asks of a plan to run: the size and the kind of server it is. */
export async function desiredRuns(
  q: Queryable,
  server: Pick<MinecraftServer, 'memoryTier' | 'desiredRevisionId'>,
) {
  return runsOf(
    server.memoryTier,
    await loadRevisionFields(q, server.desiredRevisionId, ['loader', 'mods', 'modpack']),
  )
}
