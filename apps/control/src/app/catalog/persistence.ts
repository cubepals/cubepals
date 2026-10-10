// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Queryable, schema } from '@blockly/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'

const projects = schema.catalogProjects
const versions = schema.catalogVersions

export interface CachedState {
  id: string
  state: string
  absentStreak: number
}

/**
 * Everything the cache must follow (§15.3): the catalog projects and versions pinned by a
 * revision of any server that isn't purged, and the allowlisted projects.
 */
export async function trackedSet(
  q: Queryable,
  catalog: string,
): Promise<{ projects: string[]; versions: Array<{ versionId: string; projectId: string }> }> {
  const pinned = await q.execute<{ project_id: string; version_id: string }>(sql`
    select distinct m->'source'->>'projectId' as project_id, m->'source'->>'versionId' as version_id
    from ${schema.serverRevisions} r
    join ${schema.minecraftServers} s on s.id = r.server_id
    cross join lateral jsonb_array_elements(r.mods) m
    where s.status <> 'purged' and m->'source'->>'catalog' = ${catalog} and m->'source' ? 'versionId'
  `)
  const allowed = await q
    .select({ projectId: schema.trustedModProjects.projectId })
    .from(schema.trustedModProjects)
    .where(eq(schema.trustedModProjects.catalog, catalog))
  return {
    projects: [...new Set([...pinned.rows.map((r) => r.project_id), ...allowed.map((a) => a.projectId)])],
    versions: pinned.rows.map((r) => ({ versionId: r.version_id, projectId: r.project_id })),
  }
}

export async function cachedProjects(
  q: Queryable,
  catalog: string,
  ids: string[],
): Promise<Map<string, CachedState>> {
  if (ids.length === 0) return new Map()
  const rows = await q
    .select({ id: projects.projectId, state: projects.state, absentStreak: projects.absentStreak })
    .from(projects)
    .where(and(eq(projects.catalog, catalog), inArray(projects.projectId, ids)))
  return new Map(rows.map((row) => [row.id, row]))
}

export async function cachedVersions(
  q: Queryable,
  catalog: string,
  ids: string[],
): Promise<Map<string, CachedState>> {
  if (ids.length === 0) return new Map()
  const rows = await q
    .select({ id: versions.versionId, state: versions.state, absentStreak: versions.absentStreak })
    .from(versions)
    .where(and(eq(versions.catalog, catalog), inArray(versions.versionId, ids)))
  return new Map(rows.map((row) => [row.id, row]))
}

export async function saveProjectState(
  q: Queryable,
  catalog: string,
  row: { projectId: string; state: string; absentStreak: number; changed: boolean },
  at: Date,
): Promise<void> {
  await q
    .insert(projects)
    .values({
      catalog,
      projectId: row.projectId,
      state: row.state,
      absentStreak: row.absentStreak,
      fetchedAt: at,
      stateChangedAt: at,
    })
    .onConflictDoUpdate({
      target: [projects.catalog, projects.projectId],
      set: {
        state: row.state,
        absentStreak: row.absentStreak,
        fetchedAt: at,
        ...(row.changed ? { stateChangedAt: at } : {}),
      },
    })
}

export async function saveVersionState(
  q: Queryable,
  catalog: string,
  row: { versionId: string; projectId: string; state: string; absentStreak: number; changed: boolean },
  at: Date,
): Promise<void> {
  await q
    .insert(versions)
    .values({
      catalog,
      versionId: row.versionId,
      projectId: row.projectId,
      state: row.state,
      absentStreak: row.absentStreak,
      fetchedAt: at,
      stateChangedAt: at,
    })
    .onConflictDoUpdate({
      target: [versions.catalog, versions.versionId],
      set: {
        state: row.state,
        absentStreak: row.absentStreak,
        fetchedAt: at,
        ...(row.changed ? { stateChangedAt: at } : {}),
      },
    })
}

/** A full refresh of `catalog` answered at `at`. */
export async function recordRefresh(q: Queryable, catalog: string, at: Date): Promise<void> {
  await q
    .insert(schema.catalogRefreshes)
    .values({ catalog, refreshedAt: at })
    .onConflictDoUpdate({ target: schema.catalogRefreshes.catalog, set: { refreshedAt: at } })
}

/** When `catalog` last answered a full refresh; null before the first. */
export async function lastRefresh(q: Queryable, catalog: string): Promise<Date | null> {
  return (await refreshRecord(q, catalog))?.refreshedAt ?? null
}

/** The last refresh that answered, and the last that asked and got no answer; null before the first. */
export async function refreshRecord(
  q: Queryable,
  catalog: string,
): Promise<{ refreshedAt: Date; failedAt: Date | null } | null> {
  const [row] = await q
    .select({ refreshedAt: schema.catalogRefreshes.refreshedAt, failedAt: schema.catalogRefreshes.failedAt })
    .from(schema.catalogRefreshes)
    .where(eq(schema.catalogRefreshes.catalog, catalog))
  return row ?? null
}

/** A refresh asked and the catalog didn't answer. Before any refresh has answered, nothing to mark. */
export async function recordRefreshFailure(q: Queryable, catalog: string, at: Date): Promise<void> {
  await q
    .update(schema.catalogRefreshes)
    .set({ failedAt: at })
    .where(eq(schema.catalogRefreshes.catalog, catalog))
}

/** The last known catalog states of these projects and versions; unknown ids are left out. */
export async function catalogStates(
  q: Queryable,
  catalog: string,
  ids: { projects: string[]; versions: string[] },
): Promise<{ projects: Map<string, string>; versions: Map<string, string> }> {
  const known = await cachedProjects(q, catalog, ids.projects)
  const knownVersions = await cachedVersions(q, catalog, ids.versions)
  return {
    projects: new Map([...known].map(([id, row]) => [id, row.state])),
    versions: new Map([...knownVersions].map(([id, row]) => [id, row.state])),
  }
}

/**
 * Pinned catalog mods taken down where they were published, by the last known states: a project
 * withheld or no longer shown, or a version no longer shown (§15.3).
 */
export async function revokedIn(q: Queryable, mods: readonly PinnedMod[]): Promise<PinnedMod[]> {
  const revoked: PinnedMod[] = []
  const byCatalog = new Map<string, Array<{ mod: PinnedMod; projectId: string; versionId: string }>>()
  for (const mod of mods)
    if ('versionId' in mod.source) {
      const { catalog, projectId, versionId } = mod.source
      byCatalog.set(catalog, [...(byCatalog.get(catalog) ?? []), { mod, projectId, versionId }])
    }
  for (const [catalog, pinned] of byCatalog) {
    const states = await catalogStates(q, catalog, {
      projects: pinned.map((p) => p.projectId),
      versions: pinned.map((p) => p.versionId),
    })
    for (const { mod, projectId, versionId } of pinned) {
      const project = states.projects.get(projectId)
      if (project === 'withheld' || project === 'absent' || states.versions.get(versionId) === 'absent')
        revoked.push(mod)
    }
  }
  return revoked
}
