// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Exact configuration identity and runtime-spec construction shared by all mod verification callers. */
import { createHash } from 'node:crypto'
import type { ModValidationPlanJson, Queryable } from '@blockly/db'
import type { ModArtifact } from '../../domain/mods/artifact.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { isMemoryTier } from '../../domain/server/size.ts'
import { installsAsDatapack } from '../../minecraft/mods.ts'
import { imageFor, toRuntimeSpec } from '../../minecraft/runtime-spec.ts'
import { javaFor } from '../../minecraft/versions.ts'

import { withCompressedFiles } from '../servers/carried-files.ts'
import { packOf } from '../servers/revision-reads.ts'
import { withoutMalware, withWhatItsPackLearned } from '../servers/specs.ts'

/** Bump when verification semantics change so old boot evidence cannot validate a new compiler. */
const POLICY_VERSION = 1

export function validationRevision(plan: ModValidationPlanJson, id: string): ServerRevision {
  return {
    ...plan,
    modpack: packOf(plan.modpack),
    id,
    serverId: id,
    number: 1,
    reason: 'created',
    basedOnRevisionId: null,
    acknowledgedRevoked: [],
    createdBy: 'system:mod-validation',
  }
}

export function validationKey(plan: ModValidationPlanJson): string {
  const revision = validationRevision(plan, '')
  const mods = artifactIdentities(plan.mods, plan.loader)
  const files = [...plan.files].sort((a, b) => a.path.localeCompare(b.path))
  return createHash('sha256')
    .update(
      JSON.stringify({
        policy: POLICY_VERSION,
        image: imageFor(revision),
        java: javaFor(plan.gameVersion),
        gameVersion: plan.gameVersion,
        loader: plan.loader,
        loaderVersion: plan.loaderVersion,
        mods,
        compat: artifactIdentities(plan.compat, plan.loader),
        storageGb: plan.storageGb,
        provider: plan.provider,
        region: plan.regionKey,
        pack: plan.modpack,
        files,
        memoryTier: plan.memoryTier,
        settings: { ...plan.settings, motd: undefined },
      }),
    )
    .digest('hex')
}

export function validationSpec(
  plan: ModValidationPlanJson,
  id: string,
  password: string,
  artifactUrl: (artifact: ModArtifact) => string,
) {
  if (!isMemoryTier(plan.memoryTier)) throw new Error('Unknown validation server size')
  const revision = validationRevision(plan, id)
  const spec = toRuntimeSpec({
    serverId: id,
    revision,
    world: {
      id,
      serverId: id,
      levelName: 'world',
      name: 'Compatibility check',
      seed: '0',
      levelType: 'minecraft:normal',
      hardcore: false,
      generatedOnVersion: plan.gameVersion,
    },
    memoryTier: plan.memoryTier,
    rconPassword: password,
    artifactUrl,
    compat: plan.compat,
    limits: { storageGb: plan.storageGb, worldRadius: null, playerIdleKickMinutes: null },
    iconUrl: null,
  })
  // No player route, join reporter, account secret or original world is attached to a check.
  return withCompressedFiles({
    ...spec,
    ports: spec.ports.map((port) => ({ ...port, audience: ['control'] as const })),
    labels: { ...spec.labels, 'blockly.purpose': 'mod-validation' },
  })
}

/** The same pack corrections and malware exclusions used for the player's runtime. */
export async function currentValidationPlan(
  q: Queryable,
  plan: ModValidationPlanJson,
): Promise<ModValidationPlanJson> {
  const revision = await withoutMalware(q, await withWhatItsPackLearned(q, validationRevision(plan, '')))
  return { ...plan, mods: revision.mods, modpack: revision.modpack }
}

function artifactIdentities(mods: ModValidationPlanJson['mods'], loader: ModValidationPlanJson['loader']) {
  return mods
    .map((mod) => ({
      sha512: mod.artifact.sha512,
      fileName: mod.artifact.fileName,
      dir: mod.dir ?? null,
      datapack: installsAsDatapack(mod, loader),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
