// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The updates a server's mods have, found by Cubepals rather than asked for: the Mods page and the
 * server's page offer them, so an owner learns of one there and not from a mod complaining in the
 * game's chat. Nothing here changes a server. An update goes on only when its owner applies it, as
 * any mod change, with the server going back by itself if it doesn't start.
 *
 * What is offered is checked first, the way a change is (`ModService`): every newer version is
 * resolved together with the rest of the server's mods, against its Minecraft, its server type, its
 * Java and what each jar asks for. Only a version published after the one pinned counts, so a mod
 * pinned on a beta is never "updated" back to an older release. When the whole set can't run
 * together, the largest set of updates that can is offered, and the rest wait.
 *
 * Not for pack servers: a pack updates as a whole (`PackService.updateFor`).
 */

import { MINUTE_MS } from '@blockly/contracts/durations'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import { identity, type ModChange, type ModPlan } from './service.ts'

/** A change planned on the server's own Minecraft and type, with nothing written. */
type Planner = (desired: ServerRevision, change: ModChange) => Promise<ModPlan>

type Updated = Extract<ModPlan, { kind: 'ok' }>['updated']

/**
 * What was found: each mod's version by `identity`, and the change that was checked, which is the
 * one to apply. A mod whose update works only beside another's is never offered on its own.
 */
export interface Found {
  versions: ReadonlyMap<string, string>
  upgrade: NonNullable<ModChange['upgrade']>
}

const NONE: Found = { versions: new Map(), upgrade: [] }

/** How long the updates found for one revision are kept: a page opened again asks nobody. */
const KEPT_MS = 5 * MINUTE_MS
/** Revisions whose updates are kept at once; the oldest go first. */
const MOST_KEPT = 1_000
/** Rounds of narrowing the set to versions that are newer, before it is taken as it is. */
const NARROWING_ROUNDS = 3
/** Mods tried one by one when the whole set can't update together. */
const MOST_TRIED = 40

export class ModUpdates {
  readonly #plan: Planner
  readonly #catalog: Pick<ModCatalog, 'versionsByIds'>
  readonly #kept = new Map<string, { until: number; found: Found }>()

  constructor(deps: { plan: Planner; catalog: Pick<ModCatalog, 'versionsByIds'> }) {
    this.#plan = deps.plan
    this.#catalog = deps.catalog
  }

  /**
   * The mods with an update this revision can run, and the change that applies them. None for a
   * pack server, one with no catalog mods, or one already up to date.
   */
  async of(desired: ServerRevision): Promise<Found> {
    if (desired.modpack !== null || !desired.mods.some((m) => 'versionId' in m.source)) return NONE
    const kept = this.#kept.get(desired.id)
    if (kept !== undefined && kept.until > Date.now()) return kept.found
    const found = (await this.#together(desired)) ?? (await this.#oneByOne(desired))
    this.#keep(desired.id, found)
    return found
  }

  /** Every update at once, narrowed to the ones that are newer; null when they can't run together. */
  async #together(desired: ServerRevision): Promise<Found | null> {
    let upgrade: ModChange['upgrade'] = 'all'
    for (let round = 0; round < NARROWING_ROUNDS; round++) {
      const plan = await this.#plan(desired, { upgrade })
      if (plan.kind === 'conflicts') return null
      const newer = await this.#newer(plan.updated)
      if (newer.length === plan.updated.length)
        return newer.length === 0 ? NONE : { versions: labels(newer), upgrade }
      if (newer.length === 0) return NONE
      upgrade = newer.map(({ to }) => identity(to))
    }
    return NONE
  }

  /**
   * The largest set that runs together, built one mod at a time: each is kept when it still
   * plans with the ones kept before it and moves nothing back.
   */
  async #oneByOne(desired: ServerRevision): Promise<Found> {
    const tried = desired.mods.filter((m) => 'versionId' in m.source).map(identity)
    let kept: string[] = []
    let found = NONE
    for (const id of tried.slice(0, MOST_TRIED)) {
      const plan = await this.#plan(desired, { upgrade: [...kept, id] })
      if (plan.kind === 'conflicts' || !plan.updated.some(({ to }) => identity(to) === id)) continue
      const newer = await this.#newer(plan.updated)
      if (newer.length !== plan.updated.length) continue
      kept = [...kept, id]
      found = { versions: labels(newer), upgrade: kept }
    }
    return found
  }

  /**
   * The moves that go forward: the version moved to was published after the one pinned. One whose
   * pinned version the catalog no longer shows moves forward too, since there is nothing to keep.
   */
  async #newer(updated: Updated): Promise<Updated> {
    const ids = updated.flatMap(({ from, to }) => [versionOf(from), versionOf(to)]).filter((v) => v !== null)
    const versions = ids.length === 0 ? new Map() : await this.#catalog.versionsByIds(ids)
    const published = (mod: PinnedMod) => {
      const id = versionOf(mod)
      return id === null ? undefined : versions.get(id)?.publishedAt.getTime()
    }
    return updated.filter(({ from, to }) => {
      const before = published(from)
      const after = published(to)
      return after !== undefined && (before === undefined || after > before)
    })
  }

  #keep(revisionId: string, found: Found) {
    this.#kept.delete(revisionId)
    this.#kept.set(revisionId, { until: Date.now() + KEPT_MS, found })
    for (const oldest of this.#kept.keys()) {
      if (this.#kept.size <= MOST_KEPT) break
      this.#kept.delete(oldest)
    }
  }
}

const versionOf = (mod: PinnedMod): string | null => ('versionId' in mod.source ? mod.source.versionId : null)

const labels = (updated: Updated): ReadonlyMap<string, string> =>
  new Map(updated.map(({ to }) => [identity(to), to.versionLabel]))
