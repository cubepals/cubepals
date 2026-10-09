import type { Db } from '@blockly/db'
import type { Loader } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { type Actor, authorize } from '../actor.ts'
import type { PackCuration } from '../curation/service.ts'
import { AppError } from '../errors.ts'
import type { ChangeOptions, RevisionService } from '../revisions/service.ts'
import { findServer, loadRevision } from '../servers/persistence.ts'
import type { SetupService } from '../setups/service.ts'
import type { PackService } from './service.ts'

/**
 * Moving a server to another pack: a newer version of the one it plays, a newer release of a pack
 * Blockly offers by name, or a newer file of a pack its owner uploaded. The pack is pinned the way
 * creating a server pins it, then applied as a change: a snapshot first, and the pack before it
 * back if the new one doesn't start.
 */
export class PackChanges {
  readonly #db: Db
  readonly #setups: SetupService
  readonly #packs: PackService
  readonly #revisions: RevisionService
  readonly #curation: PackCuration

  constructor(deps: {
    db: Db
    setups: SetupService
    packs: PackService
    revisions: RevisionService
    curation: PackCuration
  }) {
    this.#db = deps.db
    this.#setups = deps.setups
    this.#packs = deps.packs
    this.#revisions = deps.revisions
    this.#curation = deps.curation
  }

  async change(
    actor: Actor & { kind: 'user' },
    serverId: string,
    to:
      | { kind: 'catalog'; versionId: string }
      | { kind: 'curated'; version: string }
      | { kind: 'import'; importId: string },
    requestId: string,
    options: ChangeOptions = {},
  ): Promise<MinecraftServer> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const desired = await loadRevision(this.#db, server.desiredRevisionId)
    if (desired.modpack === null)
      throw new AppError(
        'invalid_choice',
        'This server doesn’t play a modpack, so there’s no pack to change.',
      )
    const next =
      to.kind === 'catalog'
        ? await this.#setups.pinnedPack(desired.modpack.projectId, to.versionId)
        : to.kind === 'curated'
          ? await this.#curated(desired.modpack.curated?.key ?? null, to.version)
          : await this.#uploaded(actor, to.importId)
    return this.#revisions.changePack(
      actor,
      serverId,
      {
        pack: next.pinned,
        gameVersion: next.gameVersion,
        loader: next.loader,
        loaderVersion: next.loaderVersion,
      },
      requestId,
      options,
    )
  }

  /** Another release of the curated pack a server plays: only one Blockly offers now. */
  async #curated(key: string | null, version: string) {
    if (key === null)
      throw new AppError('invalid_choice', 'This server’s pack isn’t one Cubepals offers by name.')
    const { release } = await this.#curation.releaseFor(key, version)
    return {
      pinned: release.pack,
      gameVersion: release.facts.gameVersion,
      loader: release.facts.loader as Loader,
      loaderVersion: release.facts.loaderVersion,
    }
  }

  async #uploaded(actor: Actor & { kind: 'user' }, importId: string) {
    const pinned = await this.#packs.pinnedFrom(actor, importId)
    if (pinned.kind === 'catalog') return this.#setups.pinnedPack(pinned.projectId, pinned.versionId)
    return {
      pinned: pinned.pinned,
      gameVersion: pinned.summary.gameVersion,
      loader: pinned.summary.loader as Loader,
      loaderVersion: pinned.summary.loaderVersion,
    }
  }
}
