import type { Db, Tx } from '@blockly/db'
import { catalogOfId } from '../../domain/mods/catalog.ts'
import type { ModCatalog, ProjectState, VersionState } from '../ports/catalog.ts'
import {
  type CachedState,
  cachedProjects,
  cachedVersions,
  lastRefresh,
  recordRefresh,
  recordRefreshFailure,
  refreshRecord,
  saveProjectState,
  saveVersionState,
  trackedSet,
} from './persistence.ts'

export interface CatalogTransition {
  catalog: string
  kind: 'project' | 'version'
  id: string
  from: string | null
  to: string
}

/** More than this without a successful refresh, while refreshes fail, is an admin alert (§15.3). */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000
/** `catalog-refresh` runs hourly; a cache older than this missed one, while no worker ran. */
const MISSED_REFRESH_MS = 60 * 60 * 1000

/**
 * The catalog states Blockly keeps for what servers pin (§15.3). Only the tracked set, only the
 * trust-relevant fields, and never expired: eligibility uses the last known state, and a
 * catalog that can't be reached leaves it as it was.
 */
export class CatalogSync {
  readonly #db: Db
  readonly #catalog: ModCatalog
  /** The catalogs a refresh asks, one after another. */
  readonly #ids: readonly string[]

  constructor(deps: { db: Db; catalog: ModCatalog }) {
    this.#db = deps.db
    this.#catalog = deps.catalog
    this.#ids = deps.catalog.ids ?? [deps.catalog.id]
  }

  /**
   * Write-through: the states resolution saw, recorded before the revision that pins them
   * exists, so every pinned project and version has a cache row. A state that moved is a
   * transition like any refresh finds (§15.3), returned so listings that pin it follow at once.
   * Each state is kept under the catalog its id names (`catalogOfId`), as the pin names it.
   */
  async recordObserved(
    observed: {
      projects: ReadonlyMap<string, ProjectState>
      versions: ReadonlyMap<string, { projectId: string; state: VersionState }>
    },
    at = new Date(),
  ): Promise<CatalogTransition[]> {
    const transitions: CatalogTransition[] = []
    const named = [...observed.projects.keys(), ...[...observed.versions.values()].map((v) => v.projectId)]
    await this.#db.transaction(async (tx) => {
      for (const catalog of new Set(named.map((id) => catalogOfId(id, this.#catalog.id)))) {
        const ours = (id: string) => catalogOfId(id, this.#catalog.id) === catalog
        const projects = [...observed.projects].filter(([projectId]) => ours(projectId))
        const versions = [...observed.versions].filter(([, { projectId }]) => ours(projectId))
        transitions.push(...(await recordStates(tx, catalog, projects, versions, at)))
      }
    })
    return transitions
  }

  /**
   * `catalog-refresh`: every tracked state read again, since a project's `updated` date doesn't
   * move when its status does, one catalog after another. A catalog that can't be reached throws,
   * and nothing of its changes; the ones before it keep what they found.
   */
  async refresh(at = new Date()): Promise<CatalogTransition[]> {
    const transitions: CatalogTransition[] = []
    for (const catalog of this.#ids) transitions.push(...(await this.#refresh(catalog, at)))
    return transitions
  }

  async #refresh(catalog: string, at: Date): Promise<CatalogTransition[]> {
    const tracked = await trackedSet(this.#db, catalog)
    if (tracked.projects.length === 0 && tracked.versions.length === 0) {
      await recordRefresh(this.#db, catalog, at)
      return []
    }
    const states = await this.#catalog
      .states({ projects: tracked.projects, versions: tracked.versions.map((v) => v.versionId) })
      .catch(async (error: unknown) => {
        await recordRefreshFailure(this.#db, catalog, at)
        throw error
      })
    const transitions: CatalogTransition[] = []
    await this.#db.transaction(async (tx) => {
      const knownProjects = await cachedProjects(tx, catalog, tracked.projects)
      for (const projectId of tracked.projects) {
        const observed = states.projects.get(projectId) ?? 'absent'
        const known = knownProjects.get(projectId)
        const next = following(known, observed)
        if (next.changed)
          transitions.push({
            catalog,
            kind: 'project',
            id: projectId,
            from: known?.state ?? null,
            to: next.state,
          })
        await saveProjectState(tx, catalog, { projectId, ...next }, at)
      }
      const knownVersions = await cachedVersions(
        tx,
        catalog,
        tracked.versions.map((v) => v.versionId),
      )
      for (const { versionId, projectId } of tracked.versions) {
        const observed = states.versions.get(versionId) ?? 'absent'
        const known = knownVersions.get(versionId)
        const next = following(known, observed)
        if (next.changed)
          transitions.push({
            catalog,
            kind: 'version',
            id: versionId,
            from: known?.state ?? null,
            to: next.state,
          })
        await saveVersionState(tx, catalog, { versionId, projectId, ...next }, at)
      }
      await recordRefresh(tx, catalog, at)
    })
    return transitions
  }

  /** When the catalog last answered a full refresh; null before the first. */
  lastHeard(): Promise<Date | null> {
    return lastRefresh(this.#db, this.#catalog.id)
  }

  /**
   * When the cache last heard from the catalog, if that is longer ago than an admin should allow
   * and a refresh has asked since and got no answer. A cache that only grew old, because no
   * worker ran to ask, is refreshed as one starts (`missedRefresh`) rather than reported.
   */
  async staleSince(now = new Date()): Promise<Date | null> {
    const record = await refreshRecord(this.#db, this.#catalog.id)
    if (record === null || record.failedAt === null || record.failedAt <= record.refreshedAt) return null
    return now.getTime() - record.refreshedAt.getTime() > STALE_AFTER_MS ? record.refreshedAt : null
  }

  /** Whether a scheduled refresh was missed, as it is after the platform was down a while. */
  async missedRefresh(now = new Date()): Promise<boolean> {
    const at = await this.lastHeard()
    return at !== null && now.getTime() - at.getTime() > MISSED_REFRESH_MS
  }
}

/** One catalog's observed states written through, and the ones that moved. */
async function recordStates(
  tx: Tx,
  catalog: string,
  projects: ReadonlyArray<[string, ProjectState]>,
  versions: ReadonlyArray<[string, { projectId: string; state: VersionState }]>,
  at: Date,
): Promise<CatalogTransition[]> {
  const transitions: CatalogTransition[] = []
  const known = await cachedProjects(
    tx,
    catalog,
    projects.map(([projectId]) => projectId),
  )
  for (const [projectId, state] of projects) {
    const from = known.get(projectId)?.state ?? null
    const changed = from !== state
    if (changed && from !== null)
      transitions.push({ catalog, kind: 'project', id: projectId, from, to: state })
    await saveProjectState(tx, catalog, { projectId, state, absentStreak: 0, changed }, at)
  }
  const knownVersions = await cachedVersions(
    tx,
    catalog,
    versions.map(([versionId]) => versionId),
  )
  for (const [versionId, { projectId, state }] of versions) {
    const from = knownVersions.get(versionId)?.state ?? null
    const changed = from !== state
    if (changed && from !== null)
      transitions.push({ catalog, kind: 'version', id: versionId, from, to: state })
    await saveVersionState(tx, catalog, { versionId, projectId, state, absentStreak: 0, changed }, at)
  }
  return transitions
}

/**
 * The state to keep after one observation. `withheld` is explicit and applies at once; the
 * catalog leaving something out could be one bad response, so `absent` needs two in a row.
 */
function following(
  known: CachedState | undefined,
  observed: string,
): { state: string; absentStreak: number; changed: boolean } {
  if (observed !== 'absent') return { state: observed, absentStreak: 0, changed: known?.state !== observed }
  const absentStreak = (known?.absentStreak ?? 0) + 1
  if (known === undefined || absentStreak >= 2)
    return { state: 'absent', absentStreak, changed: known?.state !== 'absent' }
  return { state: known.state, absentStreak, changed: false }
}
