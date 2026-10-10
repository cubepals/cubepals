// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a worker checks again before it boots a server (§9): that its owner may still run it, and
 * that every jar it needs can be handed to it. It only answers; refusing, failing or stopping the
 * server on that answer is the handler's.
 */
import type { AppliedConfigJson, Db } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { type ArtifactService, ArtifactUnavailable } from '../../artifacts/service.ts'
import { PermanentFailure } from '../../errors.ts'
import type { AccessPolicy } from '../../policy/access-policy.ts'
import type { DesiredRuntime } from '../../servers/specs.ts'

export type Rechecks = ReturnType<typeof rechecks>

export function rechecks(deps: {
  db: Db
  policy: Pick<AccessPolicy, 'check'>
  artifacts: Pick<ArtifactService, 'preflight'>
}) {
  const { db, artifacts } = deps

  /** Quotas were counted when the request was accepted; switches and standing may have changed. */
  const stillAllowed = (server: MinecraftServer, kind: 'continue_provisioning' | 'continue_starting') =>
    db.transaction((tx) => deps.policy.check(tx, server.ownerId, { kind }))

  /**
   * Whether work that ends with the server running may boot it. One that was running keeps its
   * slot; bringing back a failed one is a start, and is re-checked as one (§9).
   */
  const mayBoot = async (server: MinecraftServer, input: { running: boolean; fromFailure?: boolean }) => {
    if (!input.running) return { up: false, refusal: null }
    if (!input.fromFailure) return { up: true, refusal: null }
    const decision = await stillAllowed(server, 'continue_starting')
    return decision.ok ? { up: true, refusal: null } : { up: false, refusal: decision.message }
  }

  /**
   * Every jar a configuration needs can be handed to its server, checked before the runtime is
   * touched (§15.2). A configuration the server already ran has its jars on disk.
   */
  const preflight = async (desired: DesiredRuntime, applied: AppliedConfigJson | null) => {
    if (applied?.specDigest === desired.digest) return
    try {
      await artifacts.preflight(desired.revision)
    } catch (error) {
      if (error instanceof ArtifactUnavailable) throw new PermanentFailure(error.message)
      throw error
    }
  }

  return { stillAllowed, mayBoot, preflight }
}
