/**
 * The admins' view of templates' plugins: every version Cubepals tested past what its catalog
 * lists, with the day it was tested, and which templates' plugins trail the newest release Cubepals
 * offers for their server type. It only reads, and asks the catalog what each plugin lists now.
 *
 * It doesn't decide who may see it: the service lets only admins ask. It never moves a world
 * forward either; that stays the owner's one-way decision on their server.
 */
import type {
  CompatibilityAdminView,
  TemplateCompatibilityAdminView,
  TestedVersionAdminView,
} from '@blockly/contracts'
import { catalogLoadersFor } from '../../minecraft/mods.ts'
import { compareVersions, LOADER_LABELS, offeredVersions, supports } from '../../minecraft/versions.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import type { Template } from '../setups/templates.ts'
import { type TestedVersion, testedOn } from './tested.ts'

/** Every template that brings plugins or mods, and every tested version. */
export async function compatibilityView(
  catalog: ModCatalog,
  templates: readonly Template[],
  tested: readonly TestedVersion[],
): Promise<CompatibilityAdminView> {
  const withPlugins = templates.filter((template) => template.setup.mods.length > 0)
  return {
    templates: await Promise.all(withPlugins.map((template) => templateView(catalog, template, tested))),
    tested: tested.map(testedView),
  }
}

/**
 * A template against the newest release Cubepals offers for its server type: each plugin either
 * lists that release, has a version tested on it, or holds the template back.
 */
async function templateView(
  catalog: ModCatalog,
  template: Template,
  tested: readonly TestedVersion[],
): Promise<TemplateCompatibilityAdminView> {
  const { loader } = template.setup
  const newest =
    offeredVersions()
      .map((offered) => offered.id)
      .filter((id) => supports(id, loader))
      .sort((a, b) => compareVersions(b, a))[0] ?? ''
  const covering = testedOn(tested, { gameVersion: newest, loader })
  const plugins = await Promise.all(
    template.setup.mods.map(async (mod) => {
      const [project, fitting] = await Promise.all([
        catalog.project(mod.projectId),
        catalog.versions(mod.projectId, { gameVersion: newest, loaders: catalogLoadersFor(loader) }),
      ])
      return {
        name: project?.name ?? mod.projectId,
        lists: fitting.length > 0,
        records: covering.filter((record) => record.projectId === project?.projectId),
        newestListed: newestRelease(project?.gameVersions ?? []),
      }
    }),
  )
  const behind = plugins.filter((plugin) => !plugin.lists && plugin.records.length === 0)
  const carried = plugins.flatMap((plugin) => (plugin.lists ? [] : plugin.records))
  return {
    key: template.key,
    title: template.title,
    loaderLabel: LOADER_LABELS[loader],
    newest,
    status: behind.length > 0 ? 'lagging' : carried.length > 0 ? 'covered' : 'current',
    behind: behind.map(({ name, newestListed }) => ({ name, newestListed })),
    tested: carried.map(testedView),
  }
}

/** The newest full release in a list a catalog gives, skipping snapshots and candidates. */
function newestRelease(gameVersions: readonly string[]): string | null {
  return (
    gameVersions.filter((id) => /^\d+(\.\d+)+$/.test(id)).sort((a, b) => compareVersions(b, a))[0] ?? null
  )
}

function testedView(record: TestedVersion): TestedVersionAdminView {
  return {
    name: record.name,
    versionLabel: record.versionLabel,
    gameVersion: record.gameVersion,
    loaderLabel: LOADER_LABELS[record.loader],
    build: record.build,
    testedOn: record.testedOn,
    testedBy: record.testedBy,
    evidence: record.evidence,
  }
}
