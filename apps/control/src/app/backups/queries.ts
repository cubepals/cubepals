// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Availability, BackupsView, BackupView } from '@blockly/contracts'
import { DAY_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import type { Capability, Decision } from '../../domain/policy/policy.ts'
import { compareVersions } from '../../minecraft/versions.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { type Actor, authorize } from '../actor.ts'
import { pendingOfKind } from '../operations/persistence.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import { findServer } from '../servers/persistence.ts'
import { type RevisionSummary, summariesOf } from '../servers/revision-reads.ts'
import { listWorlds } from '../worlds/persistence.ts'
import { type BackupRecord, listBackups } from './persistence.ts'

/** A failed archive stays in view this long, so its owner learns it didn't happen. */
const FAILED_SHOWN_MS = 3 * DAY_MS

export class BackupQueries {
  readonly #db: Db
  readonly #policy: AccessPolicy

  constructor(deps: { db: Db; policy: AccessPolicy }) {
    this.#db = deps.db
    this.#policy = deps.policy
  }

  /**
   * Backups that can be restored, newest first, each with the world and configuration it holds,
   * and archives on their way or recently failed.
   */
  async list(actor: Actor, serverId: string, now = new Date()): Promise<BackupsView> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const shown = (backup: BackupRecord) =>
      backup.status === 'ready' ||
      (backup.tier === 'archive' && backup.status === 'pending') ||
      (backup.status === 'failed' && now.getTime() - backup.createdAt.getTime() < FAILED_SHOWN_MS)
    const listed = (await listBackups(this.#db, server.id)).filter(shown)
    const worlds = new Map((await listWorlds(this.#db, server.id)).map((w) => [w.id, w]))
    const revisions = await summariesOf(this.#db, [
      server.desiredRevisionId,
      ...listed.map((b) => b.revisionId),
    ])
    const desired = summaryOf(revisions, server.desiredRevisionId)
    const standing = await loadStanding(this.#db, server.ownerId)
    const availability = (capability: Capability) =>
      this.#db.transaction(async (tx) =>
        toAvailability(await this.#policy.check(tx, server.ownerId, capability)),
      )
    return {
      kept: entitlementsFor(standing.plan, standing.limitOverrides).backupPolicy.snapshotsKept,
      inProgress: await pendingOfKind(this.#db, server.id, 'backup'),
      timeZone: standing.timeZone,
      archives: {
        create: await availability({ kind: 'create_archive' }),
        restore: await availability({ kind: 'restore_archive' }),
      },
      backups: listed.map((backup): BackupView => {
        const revision = summaryOf(revisions, backup.revisionId)
        return {
          id: backup.id,
          trigger: backup.trigger,
          tier: backup.tier,
          status: backup.status as BackupView['status'],
          error: backup.error,
          createdAt: backup.createdAt.toISOString(),
          expiresAt: backup.expiresAt?.toISOString() ?? null,
          sizeBytes: backup.sizeBytes,
          world: { id: backup.worldId, name: worlds.get(backup.worldId)?.name ?? 'A world' },
          configuration: {
            revisionNumber: revision.number,
            gameVersion: revision.gameVersion,
            loader: revision.loader,
            mods: revision.modNames.length,
          },
          needsConfiguration: compareVersions(revision.gameVersion, desired.gameVersion) > 0,
        }
      }),
    }
  }
}

export const summaryOf = (found: Map<string, RevisionSummary>, id: string): RevisionSummary => {
  const summary = found.get(id)
  if (summary === undefined) throw new Error(`Revision ${id} is missing`)
  return summary
}

const toAvailability = (decision: Decision): Availability =>
  decision.ok ? { available: true } : { available: false, code: decision.code, message: decision.message }
