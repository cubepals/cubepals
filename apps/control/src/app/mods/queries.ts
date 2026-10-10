// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  Availability,
  ModPlanView,
  ModsView,
  ModUploadView,
  ModView,
  PackUpdateView,
} from '@blockly/contracts'
import type { Db } from '@blockly/db'
import { forPlayers, type PinnedMod } from '../../domain/mods/artifact.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { catalogLoadersFor, installsAsDatapack, projectTypesFor } from '../../minecraft/mods.ts'
import { modName } from '../../minecraft/pack-build.ts'
import { fits } from '../../minecraft/uploads.ts'
import { compareVersions, LOADER_LABELS, loaderForMods } from '../../minecraft/versions.ts'
import { type Actor, authorize } from '../actor.ts'
import { revokedIn } from '../catalog/persistence.ts'
import type { PackCuration } from '../curation/service.ts'
import type { PackContents } from '../packs/contents.ts'
import type { PackService } from '../packs/service.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import { findServer, loadRevision } from '../servers/persistence.ts'
import { packView } from './pack.ts'
import { identity, type ModPlan } from './service.ts'
import { listModUploads, type ModUploadRecord, uploadInUse } from './uploads.ts'

export class ModQueries {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #catalog: ModCatalog
  readonly #packs: PackService
  readonly #contents: PackContents
  readonly #curation: PackCuration

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    catalog: ModCatalog
    packs: PackService
    contents: PackContents
    curation: PackCuration
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#catalog = deps.catalog
    this.#packs = deps.packs
    this.#contents = deps.contents
    this.#curation = deps.curation
  }

  /** Where people read about a mod: its catalog's page, when it came from this catalog. */
  #page = (mod: PinnedMod): string | null =>
    'projectId' in mod.source && (this.#catalog.ids ?? [this.#catalog.id]).includes(mod.source.catalog)
      ? this.#catalog.projectPage(mod.source.projectId)
      : null

  /** A mod plan as the page shows it. */
  planView(plan: ModPlan): ModPlanView {
    if (plan.kind === 'conflicts') return { ...plan, movesTo: plan.movesTo ?? null }
    const revoked = new Set(plan.revoked.map(identity))
    const players = new Set(forPlayers(plan.mods).map(identity))
    const view = (mod: PinnedMod) => modView(mod, plan.loader, revoked, this.#page(mod), players)
    return {
      kind: 'ok',
      loader: plan.loader,
      added: plan.added.map(view),
      removed: plan.removed.map(view),
      updated: plan.updated.map(({ from, to }) => ({ from: view(from), to: view(to) })),
      revoked: plan.revoked.map(view),
      expected: plan.mods.map((m) => m.artifact.sha512).sort(),
    }
  }

  /** The mods the server should run: its desired revision's, each with whether it was taken down. */
  async list(actor: Actor, serverId: string): Promise<ModsView> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const revision = await loadRevision(this.#db, server.desiredRevisionId)
    const revoked = new Set((await revokedIn(this.#db, revision.mods)).map(identity))
    const players = new Set(forPlayers(revision.mods).map(identity))
    // A vanilla world can still be given a mod: Blockly moves it to a server type that runs one,
    // so the page offers what that type takes rather than an empty page and a decision.
    const switchesTo = revision.loader === 'vanilla' ? loaderForMods(revision.gameVersion) : null
    const [type] = projectTypesFor(switchesTo ?? revision.loader)
    const kinds = { mod: 'mods', plugin: 'plugins', datapack: 'datapacks' } as const
    return {
      kind: type === undefined ? null : kinds[type],
      gameVersion: revision.gameVersion,
      loader: revision.loader,
      switchesTo: switchesTo === null ? null : { loader: switchesTo, label: LOADER_LABELS[switchesTo] },
      mods: revision.mods.map((mod) => modView(mod, revision.loader, revoked, this.#page(mod), players)),
      modpack: packView(this.#catalog, revision),
      // A catalog that can't be asked now just shows no update; the pack runs as it is.
      packUpdate: await this.#packUpdate(revision).catch(() => null),
      packUploaded: revision.modpack?.catalog === 'upload',
      packLeftOut: revision.modpack === null ? [] : await this.#leftOut(revision.modpack.artifact.sha512),
      uploads: await this.#db.transaction(async (tx): Promise<Availability> => {
        const decision = await this.#policy.check(tx, server.ownerId, { kind: 'upload_mod' })
        return decision.ok
          ? { available: true }
          : { available: false, code: decision.code, message: decision.message }
      }),
    }
  }

  /**
   * The newer pack a server may move to. A curated one is offered its review's next published
   * release and nothing else, never whatever its catalog published since; a world never moves back.
   */
  async #packUpdate(revision: ServerRevision): Promise<PackUpdateView | null> {
    if (revision.modpack?.curated === undefined) return this.#packs.updateFor(revision)
    const newer = await this.#curation.newerFor(revision.modpack)
    if (newer === null) return null
    const { gameVersion } = newer.release.facts
    if (compareVersions(gameVersion, revision.gameVersion) < 0) return null
    return {
      versionId: newer.release.pack.versionId,
      label: newer.release.version,
      gameVersion,
      movesWorld: compareVersions(gameVersion, revision.gameVersion) > 0,
      release: newer.release.version,
    }
  }

  /** The pack's mods the server leaves to players' games, by the names people know them by. */
  async #leftOut(sha512: string): Promise<string[]> {
    const contents = await this.#contents.load(sha512)
    return [
      ...new Set(
        (contents?.leftOut ?? [])
          .filter((l) => l.why === 'players' || l.why === 'crashed')
          .map((l) => modName(l.path)),
      ),
    ]
  }

  /**
   * The owner's uploads, newest first: whether each would run on this server as it is now, and
   * whether a server still has it (then it can't be deleted).
   */
  async uploads(actor: Actor, serverId: string): Promise<ModUploadView[]> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const revision = await loadRevision(this.#db, server.desiredRevisionId)
    // As in `list`: a vanilla world is judged by the type it would move to.
    const loaders = catalogLoadersFor(
      (revision.loader === 'vanilla' ? loaderForMods(revision.gameVersion) : null) ?? revision.loader,
    )
    const all = await listModUploads(this.#db, server.ownerId)
    return Promise.all(
      all.map(async (upload) =>
        uploadView(upload, {
          inUse: await uploadInUse(this.#db, upload.id),
          fits:
            upload.metadata.loaders.some((l) => loaders.includes(l)) &&
            fits(upload.metadata.gameVersions, revision.gameVersion),
        }),
      ),
    )
  }
}

function uploadView(upload: ModUploadRecord, facts: { inUse: boolean; fits: boolean }): ModUploadView {
  return {
    id: upload.id,
    fileName: upload.fileName,
    name: upload.metadata.name,
    version: upload.metadata.version,
    loaders: upload.metadata.loaders,
    sizeBytes: upload.sizeBytes,
    createdAt: upload.createdAt.toISOString(),
    inUse: facts.inUse,
    fits: facts.fits,
  }
}

/** `players`: the server's mods that players install, which is what the page marks for them. */
function modView(
  mod: PinnedMod,
  loader: ServerRevision['loader'],
  revoked: ReadonlySet<string>,
  page: string | null,
  players: ReadonlySet<string>,
): ModView {
  return {
    id: identity(mod),
    name: mod.name,
    versionLabel: mod.versionLabel,
    origin: mod.origin,
    requiredBy: mod.requiredBy,
    environment: players.has(identity(mod)) ? 'both' : 'server',
    source: 'projectId' in mod.source ? 'catalog' : 'upload',
    url: page,
    revoked: revoked.has(identity(mod)),
    datapack: installsAsDatapack(mod, loader),
  }
}
