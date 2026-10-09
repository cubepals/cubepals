import type { Queryable } from '@blockly/db'
import { type CatalogView, type Trust, trust } from '../../domain/listing/trust.ts'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { ProjectState, VersionState } from '../../domain/mods/catalog.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { catalogStates } from '../catalog/persistence.ts'
import { allowlisted } from './persistence.ts'

/** The catalog cache's view of the catalog mods a revision pins, with what Blockly vouches for. */
export async function catalogViewOf(
  q: Queryable,
  mods: readonly PinnedMod[],
  vouched: ReadonlySet<string>,
): Promise<CatalogView> {
  const byCatalog = new Map<string, { projects: string[]; versions: string[] }>()
  for (const mod of mods)
    if ('versionId' in mod.source) {
      const ids = byCatalog.get(mod.source.catalog) ?? { projects: [], versions: [] }
      ids.projects.push(mod.source.projectId)
      ids.versions.push(mod.source.versionId)
      byCatalog.set(mod.source.catalog, ids)
    }
  const states = new Map<string, Awaited<ReturnType<typeof catalogStates>>>()
  for (const [catalog, ids] of byCatalog) states.set(catalog, await catalogStates(q, catalog, ids))
  return {
    allowlisted: vouched,
    project: (catalog, projectId) => (states.get(catalog)?.projects.get(projectId) as ProjectState) ?? null,
    version: (catalog, versionId) => (states.get(catalog)?.versions.get(versionId) as VersionState) ?? null,
  }
}

/**
 * What a revision runs, judged the way the directory judges it (§15.3): the one judgement behind
 * showing a server to strangers and handing strangers a copy of it.
 */
export async function trustOf(
  q: Queryable,
  revision: Pick<ServerRevision, 'mods' | 'modpack'>,
): Promise<Trust> {
  return trust(revision.mods, await catalogViewOf(q, revision.mods, await allowlisted(q)), revision.modpack)
}
