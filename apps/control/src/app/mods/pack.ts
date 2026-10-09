import type { PackView } from '@blockly/contracts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { ModCatalog } from '../ports/catalog.ts'

/**
 * The pack a revision plays, as every page shows it: the exact version it pins, and how a player
 * gets that version from its catalog. Null when it plays none.
 */
export function packView(
  catalog: ModCatalog,
  revision: Pick<ServerRevision, 'modpack' | 'gameVersion' | 'loader'>,
): PackView | null {
  const pack = revision.modpack
  if (pack === null) return null
  // Players get a pack from its authors: where servers install Blockly's copy, from the published file.
  const file = pack.publishedFile ?? (pack.artifact.ref.kind === 'remote' ? pack.artifact.ref.url : null)
  // A pack from another catalog, or one whose file isn't public, still has its page.
  const links =
    pack.catalog === catalog.id && file !== null
      ? catalog.packLinks(
          { projectId: pack.projectId, versionId: pack.versionId, file },
          { gameVersion: revision.gameVersion, loader: revision.loader },
        )
      : { page: pack.page, file, app: null }
  return {
    name: pack.name,
    version: pack.versionLabel,
    icon: pack.icon,
    page: links.page,
    file: links.file,
    app: links.app,
    environment: pack.environment,
  }
}
