// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { CompatibilityAdminView, CuratedPackAdminView } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import type { ReleaseRef } from '../../domain/mods/curation.ts'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import type { Loader } from '../../domain/revision/revision.ts'
import type { Actor } from '../actor.ts'
import type { DeploymentCapabilities } from '../capabilities.ts'
import { NotFound } from '../errors.ts'
import type { ModPlan } from '../mods/service.ts'
import type { PackContents } from '../packs/contents.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import type { FileFormats, PackArchives } from '../ports/formats.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import { TEMPLATES } from '../setups/templates.ts'
import { reviewView } from './admin-view.ts'
import { checkCatalogRelease, type PinnedCatalogPack } from './catalog-check.ts'
import { ingest, ingestGaveUp } from './ingest.ts'
import { move } from './moves.ts'
import { newerFor, type OfferedPack, offered, releaseFor } from './offering.ts'
import { OWN_PACKS, type OwnPack } from './own.ts'
import { checkOwnRelease } from './own-check.ts'
import { CURATED_PACKS, type CuratedPack } from './packs.ts'
import { queueDue } from './queue.ts'
import { compatibilityView } from './templates-view.ts'
import { TESTED } from './tested.ts'

/**
 * Packs Blockly offers by name (docs/modpack-templates.md): the reviewed releases in `packs.ts`,
 * fetched from where their authors published them, checked byte for byte, judged by their
 * licences, and kept as the pack a server of each pins. An admin offers a verified release to new
 * servers, and can withdraw it again; no server that plays it ever notices either.
 *
 * Ingestion is the only way in, and it takes nothing but what the review pinned: no address typed
 * by anyone, no file uploaded, no version the catalog merely says is newer.
 *
 * `PackCuration` hands each job only what it uses. Each job is in a file beside this one:
 * - `queue.ts`: which reviewed releases are due, recorded as pending and queued.
 * - `ingest.ts`: one pending release run through its check, its outcome kept once.
 * - `catalog-check.ts`: checking a reviewed release of a catalog pack, up to Blockly's copy.
 * - `own-check.ts`: checking a release of one of Blockly's own packs.
 * - `check-downloads.ts`: every file a pack installs, fetched and matched to its hash.
 * - `check-outcome.ts`: how a check ends: what it found, or a refusal in an admin's words.
 * - `moves.ts`: an admin publishing, withdrawing, or asking for a release to be checked again.
 * - `offering.ts`: what people making or updating a server are offered.
 * - `admin-view.ts`: the admins' page of every reviewed pack and its releases.
 * - `order.ts`: the order a pack's releases come in, newest first.
 * - `audit.ts`: one audit row about a curated release.
 * - `tested.ts`: the review of versions Cubepals ran past what their catalog lists.
 * - `templates-view.ts`: the admins' view of those, and of templates whose plugins lag.
 */

/** How long the packs new servers are offered are kept before they are read again. */
export const OFFERED_KEPT_MS = 30_000

export type { PinnedCatalogPack } from './catalog-check.ts'
export type { OfferedPack } from './offering.ts'

export class PackCuration {
  readonly #db: Db
  readonly #catalog: ModCatalog
  readonly #archives: PackArchives
  readonly #formats: FileFormats
  readonly #contents: PackContents
  readonly #caps: DeploymentCapabilities
  readonly #jobs: JobQueue
  readonly #pin: (projectId: string, versionId: string) => Promise<PinnedCatalogPack>
  readonly #resolve: (
    target: { gameVersion: string; loader: Loader },
    wanted: ReadonlyArray<{ projectId: string }>,
  ) => Promise<ModPlan>
  readonly #loaderBuilds: LoaderBuilds
  readonly #packs: readonly CuratedPack[]
  readonly #own: readonly OwnPack[]
  /** What `offered()` last answered, and when it asked; null once a move makes it out of date. */
  #offered: { at: number; packs: Promise<OfferedPack[]> } | null = null

  constructor(deps: {
    db: Db
    catalog: ModCatalog
    archives: PackArchives
    formats: FileFormats
    contents: PackContents
    capabilities: DeploymentCapabilities
    jobs: JobQueue
    /** Pins a catalog pack exactly as creating a server from it would. */
    pin: (projectId: string, versionId: string) => Promise<PinnedCatalogPack>
    /** Resolves a list of mods exactly as creating a server with them would. */
    resolve: (
      target: { gameVersion: string; loader: Loader },
      wanted: ReadonlyArray<{ projectId: string }>,
    ) => Promise<ModPlan>
    loaderBuilds: LoaderBuilds
    /** The review; tests bring their own. */
    packs?: readonly CuratedPack[]
    /** Blockly's own packs; tests bring their own. */
    own?: readonly OwnPack[]
  }) {
    this.#db = deps.db
    this.#catalog = deps.catalog
    this.#archives = deps.archives
    this.#formats = deps.formats
    this.#contents = deps.contents
    this.#caps = deps.capabilities
    this.#jobs = deps.jobs
    this.#pin = deps.pin
    this.#resolve = deps.resolve
    this.#loaderBuilds = deps.loaderBuilds
    this.#packs = deps.packs ?? CURATED_PACKS
    this.#own = deps.own ?? OWN_PACKS
  }

  // ─── Ingestion ─────────────────────────────────────────────────────────────────────────────

  /**
   * `curation`: every reviewed release Blockly hasn't seen is recorded and queued to be checked, and
   * one still pending is queued again, in case its job was lost. Returns how many were queued.
   */
  queueDue(): Promise<number> {
    return queueDue({
      db: this.#db,
      jobs: this.#jobs,
      resolve: this.#resolve,
      packs: this.#packs,
      own: this.#own,
    })
  }

  /**
   * `curation-ingest`: one reviewed release, fetched and checked (docs/modpack-templates.md
   * § Ingestion). What it finds is kept once; anything wrong refuses the release, in a sentence
   * for an admin, with the detail behind it. A catalog or a host that doesn't answer is tried again.
   */
  ingest(release: ReleaseRef): Promise<void> {
    return ingest(
      {
        db: this.#db,
        packs: this.#packs,
        own: this.#own,
        checkCatalog: (pack, spec, work) =>
          checkCatalogRelease(
            {
              catalog: this.#catalog,
              archives: this.#archives,
              formats: this.#formats,
              contents: this.#contents,
              capabilities: this.#caps,
              pin: this.#pin,
            },
            pack,
            spec,
            work,
          ),
        checkOwn: (pack, version, gameVersion, work) =>
          checkOwnRelease(
            {
              catalog: this.#catalog,
              archives: this.#archives,
              capabilities: this.#caps,
              resolve: this.#resolve,
              loaderBuilds: this.#loaderBuilds,
            },
            pack,
            version,
            gameVersion,
            work,
          ),
      },
      release,
    )
  }

  /** A check whose job gave up: refused with what went wrong, for an admin to try again. */
  ingestGaveUp(release: ReleaseRef, error: string): Promise<void> {
    return ingestGaveUp(this.#db, release, error)
  }

  // ─── Offering ──────────────────────────────────────────────────────────────────────────────

  /** An admin offering a verified release to new servers, or offering a withdrawn one again. */
  async publish(actor: Actor, release: ReleaseRef): Promise<void> {
    await move(
      { db: this.#db, packs: this.#packs, own: this.#own },
      actor,
      release,
      'publish',
      'curation.published',
    )
    this.#offered = null
  }

  /** An admin taking a release from new servers; every server that plays it keeps it. */
  async withdraw(actor: Actor, release: ReleaseRef, reason: string): Promise<void> {
    await move(
      { db: this.#db, packs: this.#packs, own: this.#own },
      actor,
      release,
      'withdraw',
      'curation.withdrawn',
      reason.trim() || null,
    )
    this.#offered = null
  }

  /** An admin asking for a refused release to be checked again, once what refused it is fixed. */
  async retry(actor: Actor, release: ReleaseRef): Promise<void> {
    await move(
      { db: this.#db, packs: this.#packs, own: this.#own },
      actor,
      release,
      'retry',
      'curation.retried',
    )
    await this.#jobs.enqueueCuration(release)
  }

  /**
   * The packs new servers are offered, in the review's order, each at its newest published
   * release. A pack no longer in the review isn't offered, whatever its releases say.
   *
   * Every create page asks, and so does every pick of a pack by name, while the answer changes
   * only when an admin publishes or withdraws a release. It is kept for a short while, forgotten
   * at once when this process moves a release, and never kept when reading it failed. Another
   * process's move shows here once the kept answer is that old.
   */
  offered(): Promise<OfferedPack[]> {
    const kept = this.#offered
    if (kept !== null && Date.now() - kept.at < OFFERED_KEPT_MS) return kept.packs
    const packs = offered(this.#db, this.#packs, this.#own)
    const keeping = { at: Date.now(), packs }
    this.#offered = keeping
    packs.catch(() => {
      if (this.#offered === keeping) this.#offered = null
    })
    return packs
  }

  /** The release a new server of a pack plays: the one asked for, which must be offered, or the newest. */
  releaseFor(key: string, version?: string): Promise<OfferedPack> {
    return releaseFor(this.#db, this.#packs, this.#own, key, version)
  }

  /**
   * The release a server that plays a curated pack is offered next: a published one newer than
   * its own in the review's order. Null for one that plays the newest, or no curated pack.
   */
  newerFor(playing: PinnedModpack): Promise<OfferedPack | null> {
    return newerFor(this.#db, this.#packs, this.#own, playing)
  }

  /** Every reviewed pack and each of its releases as checking left it, for the admins' page. */
  async review(actor: Actor): Promise<CuratedPackAdminView[]> {
    if (actor.kind !== 'admin') throw new NotFound('Curated pack')
    return reviewView(this.#db, this.#packs, this.#own)
  }

  /**
   * The versions Cubepals tested past their listing, and the templates whose plugins trail the
   * newest release Cubepals offers, for the admins' page. Asks the catalog; changes nothing.
   */
  async compatibility(actor: Actor): Promise<CompatibilityAdminView> {
    if (actor.kind !== 'admin') throw new NotFound('Curated pack')
    return compatibilityView(this.#catalog, TEMPLATES, TESTED)
  }
}
