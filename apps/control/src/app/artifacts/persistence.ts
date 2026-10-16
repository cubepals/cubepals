// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, asc, eq, inArray, lt, ne, notInArray, or, sql } from 'drizzle-orm'
import type { ModArtifact, PinnedMod } from '../../domain/mods/artifact.ts'
import { STARTER_SHA512S } from '../../minecraft/starter.ts'

const revisions = schema.serverRevisions
const servers = schema.minecraftServers
const runtimes = schema.serverRuntimes
const stored = schema.storedArtifacts
const worlds = schema.worlds

/**
 * What a server may fetch under a hash: a jar one of its revisions pins, or the modpack a
 * revision plays, which is one file pinned the same way and served over the same link. The
 * first revision to pin the bytes is when they were pinned, which never moves, since revisions
 * are never edited.
 */
export async function pinnedBy(
  q: Queryable,
  serverId: string,
  sha512: string,
): Promise<{
  mod: PinnedMod | null
  artifact: ModArtifact
  pinnedAt: Date
  refreshedAt: Date | null
} | null> {
  const [row] = await q
    .select({
      mods: revisions.mods,
      modpack: revisions.modpack,
      createdAt: revisions.createdAt,
      refreshedAt: runtimes.artifactsRefreshedAt,
    })
    .from(revisions)
    .innerJoin(servers, eq(servers.id, revisions.serverId))
    .leftJoin(runtimes, eq(runtimes.serverId, revisions.serverId))
    .where(
      and(
        eq(revisions.serverId, serverId),
        ne(servers.status, 'purged'),
        or(
          // Served by the jsonb_path_ops index on mods.
          sql`${revisions.mods} @> ${JSON.stringify([{ artifact: { sha512 } }])}::jsonb`,
          sql`${revisions.modpack} @> ${JSON.stringify({ artifact: { sha512 } })}::jsonb`,
        ),
      ),
    )
    .orderBy(asc(revisions.number))
    .limit(1)
  if (!row) return null
  const mod = row.mods.find((m) => m.artifact.sha512 === sha512) as PinnedMod | undefined
  const artifact =
    mod?.artifact ??
    (row.modpack?.artifact.sha512 === sha512 ? (row.modpack.artifact as ModArtifact) : undefined)
  if (artifact === undefined) return null
  return {
    mod: mod ?? null,
    artifact,
    pinnedAt: row.createdAt,
    refreshedAt: row.refreshedAt,
  }
}

/**
 * A Via plugin Cubepals pinned for its compatibility layer (`compat/`), which any server may fetch
 * under its hash: it is none of a revision's, and the same jar for every server on its release.
 */
export async function compatPinned(
  q: Queryable,
  sha512: string,
): Promise<{ mod: PinnedMod; pinnedAt: Date } | null> {
  const [row] = await q
    .select({ pinned: schema.compatPlugins.pinned, pinnedAt: schema.compatPlugins.pinnedAt })
    .from(schema.compatPlugins)
    .where(sql`${schema.compatPlugins.pinned} @> ${JSON.stringify({ artifact: { sha512 } })}::jsonb`)
    .orderBy(asc(schema.compatPlugins.pinnedAt))
    .limit(1)
  return row === undefined ? null : { mod: row.pinned as PinnedMod, pinnedAt: row.pinnedAt }
}

/**
 * When a server first had a world of one of these types, which start on an archive: what lets the
 * server fetch that archive. A deleted world counts, as a restore may bring it back.
 */
export async function firstWorldOfType(
  q: Queryable,
  serverId: string,
  levelTypes: readonly string[],
): Promise<Date | null> {
  if (levelTypes.length === 0) return null
  const [row] = await q
    .select({ createdAt: worlds.createdAt })
    .from(worlds)
    .innerJoin(servers, eq(servers.id, worlds.serverId))
    .where(
      and(
        eq(worlds.serverId, serverId),
        ne(servers.status, 'purged'),
        inArray(worlds.levelType, [...levelTypes]),
      ),
    )
    .orderBy(asc(worlds.createdAt))
    .limit(1)
  return row?.createdAt ?? null
}

export async function storedArtifact(q: Queryable, sha512: string): Promise<{ key: string } | null> {
  const [row] = await q.select({ key: stored.key }).from(stored).where(eq(stored.sha512, sha512))
  return row ?? null
}

export async function recordStored(
  q: Queryable,
  artifact: {
    sha512: string
    key: string
    sizeBytes: number
    source: 'upload' | 'mirror' | 'built' | 'curated'
  },
): Promise<void> {
  await q
    .insert(stored)
    .values({ ...artifact, verifiedAt: new Date() })
    .onConflictDoNothing({ target: stored.sha512 })
}

export async function markArtifactsRefreshed(q: Queryable, serverId: string, at: Date): Promise<void> {
  await q
    .update(runtimes)
    .set({ artifactsRefreshedAt: at, updatedAt: new Date() })
    .where(eq(runtimes.serverId, serverId))
}

/** How long a pack built from an upload is kept for its owner to make a server of, unpinned. */
const IMPORT_KEPT = sql`interval '30 days'`

/**
 * Stored blobs no revision of a live server pins, as a mod or as the pack it plays, stored before
 * `before`: the grace period lets an upload wait to be added, and a mirror to be pinned, before it
 * counts as unused. A pack built from an upload waits for its owner a month. Blockly's copy of a
 * curated release is kept for as long as the release was ever checked: withdrawn ones can be
 * offered again, and rolled back to. An archive a world starts on (`minecraft/starter.ts`) is
 * never unused: no revision pins it, and a new server fetches it.
 */
export async function unreferencedStored(
  q: Queryable,
  before: Date,
  limit = 200,
): Promise<Array<{ sha512: string; key: string }>> {
  return q
    .select({ sha512: stored.sha512, key: stored.key })
    .from(stored)
    .where(
      and(
        lt(stored.createdAt, before),
        notInArray(stored.sha512, [...STARTER_SHA512S]),
        sql`not exists (
          select 1 from ${revisions}
          join ${servers} on ${servers.id} = ${revisions.serverId}
          where ${servers.status} <> 'purged'
            and (${revisions.mods} @> jsonb_build_array(jsonb_build_object('artifact', jsonb_build_object('sha512', ${stored.sha512})))
              or ${revisions.modpack} @> jsonb_build_object('artifact', jsonb_build_object('sha512', ${stored.sha512})))
        )`,
        sql`not exists (
          select 1 from ${schema.packImports}
          where ${schema.packImports.packSha512} = ${stored.sha512}
            and ${schema.packImports.createdAt} > now() - ${IMPORT_KEPT}
        )`,
        sql`not exists (
          select 1 from ${schema.curatedReleases}
          where ${schema.curatedReleases.pack} -> 'artifact' ->> 'sha512' = ${stored.sha512}
            and ${schema.curatedReleases.state} <> 'refused'
        )`,
      ),
    )
    .limit(limit)
}

/**
 * Forgets a blob about to leave the store, and the uploads that pointed at it, unless a
 * revision pinned it since it was found unused.
 */
export async function forgetStored(tx: Tx, sha512: string): Promise<boolean> {
  const [pinned] = await tx
    .select({ id: revisions.id })
    .from(revisions)
    .innerJoin(servers, eq(servers.id, revisions.serverId))
    .where(
      and(
        ne(servers.status, 'purged'),
        or(
          sql`${revisions.mods} @> ${JSON.stringify([{ artifact: { sha512 } }])}::jsonb`,
          sql`${revisions.modpack} @> ${JSON.stringify({ artifact: { sha512 } })}::jsonb`,
        ),
      ),
    )
    .limit(1)
  if (pinned !== undefined) return false
  const [curated] = await tx
    .select({ key: schema.curatedReleases.packKey })
    .from(schema.curatedReleases)
    .where(
      and(
        sql`${schema.curatedReleases.pack} -> 'artifact' ->> 'sha512' = ${sha512}`,
        ne(schema.curatedReleases.state, 'refused'),
      ),
    )
    .limit(1)
  if (curated !== undefined) return false
  await tx.delete(schema.modUploads).where(eq(schema.modUploads.sha512, sha512))
  await tx.delete(schema.packImports).where(eq(schema.packImports.packSha512, sha512))
  await tx.delete(stored).where(eq(stored.sha512, sha512))
  return true
}
