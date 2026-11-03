// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** One shared preflight for creation, mod changes, packs, restores, imports and curation. */
import { Loader } from '@blockly/contracts'
import type { Db, ModValidationPlanJson } from '@blockly/db'
import { entitlementsFor, planThatRuns } from '../../domain/account/entitlements.ts'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { isMemoryTier } from '../../domain/server/size.ts'
import type { ArtifactService } from '../artifacts/service.ts'
import type { Checked } from '../curation/check-outcome.ts'
import type { Runtimes } from '../runtimes/router.ts'
import { findServer, loadRuntime } from '../servers/persistence.ts'
import { packOf } from '../servers/revision-reads.ts'
import type { DesiredRuntime, RuntimeSpecs } from '../servers/specs.ts'
import type { ModValidation } from './validation.ts'
import { currentValidationPlan, validationKey } from './validation-plan.ts'
import { IncompatibleMods } from './validation-runtime.ts'

interface PreflightDependencies {
  db: Db
  artifacts: Pick<ArtifactService, 'preflight'>
  validation: ModValidation
  runtime: Runtimes
  specs: RuntimeSpecs
  defaultRuntime: string
  defaultRegion: string
}

export class ConfigurationPreflight {
  readonly #deps: PreflightDependencies
  constructor(deps: PreflightDependencies) {
    this.#deps = deps
  }

  async plan(revision: ServerRevision, prepared?: DesiredRuntime): Promise<ModValidationPlanJson | null> {
    const { db, specs, runtime } = this.#deps
    const server = await findServer(db, revision.serverId)
    if (server === null) throw new Error('The server for this compatibility check is unavailable')
    const desired = prepared ?? (await specs.forRevision(db, server, revision))
    const binding = await loadRuntime(db, server.id, runtime.providers)
    const { gameVersion, loader, loaderVersion, settings, modpack } = desired.revision
    const { mods, files, compat } = desired.validation
    if (mods.length === 0 && compat.length === 0 && modpack === null) return null
    return {
      gameVersion,
      loader,
      loaderVersion,
      settings,
      mods,
      compat,
      modpack,
      files,
      memoryTier: server.memoryTier,
      storageGb: desired.spec.storage.sizeGb,
      provider: binding.provider,
      regionKey: server.regionKey,
    }
  }

  /** Called on workers before any player runtime is changed. */
  async check(
    revision: ServerRevision,
    prepared?: DesiredRuntime,
    checking?: () => Promise<void>,
  ): Promise<void> {
    const plan = await this.plan(revision, prepared)
    await this.#deps.artifacts.preflight(
      plan === null
        ? revision
        : { ...revision, mods: [...plan.mods, ...plan.compat], modpack: packOf(plan.modpack) },
    )
    if (plan === null) return
    await checking?.()
    await this.#verify(plan)
  }

  /** Imports use the same plan and verifier; this is a cheap API-side read/queue operation. */
  async request(revision: ServerRevision) {
    const plan = await this.plan(revision)
    return plan === null ? null : this.#deps.validation.request(plan)
  }

  /** Curation has no player server or world; use the same published sizing rules as creation. */
  async release(checked: Checked): Promise<void> {
    const { facts, pack } = checked
    if (!isMemoryTier(facts.tier)) throw new Error('Unknown pack validation size')
    const loader = Loader.parse(facts.loader)
    const choice = planThatRuns({ loader, tier: facts.tier, modded: true })
    if (choice === null) throw new Error('No offered size can validate this pack')
    const plan = entitlementsFor(choice)
    await this.#verify(
      await currentValidationPlan(this.#deps.db, {
        gameVersion: facts.gameVersion,
        loader,
        loaderVersion: facts.loaderVersion,
        settings: defaultSettings({ name: 'Compatibility check', gameMode: 'survival', maxPlayers: 1 }),
        mods: [],
        compat: [],
        modpack: pack,
        files: [],
        memoryTier: facts.tier,
        storageGb: plan.storage.startGb,
        provider: this.#deps.defaultRuntime,
        regionKey: this.#deps.defaultRegion,
      }),
    )
  }
  async #verify(plan: ModValidationPlanJson): Promise<void> {
    try {
      await this.#deps.validation.ensure(plan)
    } catch (error) {
      if (
        error instanceof IncompatibleMods &&
        validationKey(await currentValidationPlan(this.#deps.db, plan)) !== validationKey(plan)
      )
        throw new Error(
          'The loader refined this pack’s server mods. Checking the updated configuration next.',
        )
      throw error
    }
  }
}
