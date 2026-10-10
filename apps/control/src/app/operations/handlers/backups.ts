// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The backups an owner keeps: a snapshot of the server as it is, and a snapshot's world packed into
 * the archive store. Neither touches the server's status: a failure is recorded on the backup, and
 * the server carries on (§9). Putting a backup's world back is `restoring.ts`; how a copy is made
 * is `world-copies.ts`.
 */
import type { Db } from '@blockly/db'
import { entitlementsFor } from '../../../domain/account/entitlements.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import {
  archiveFailed,
  archiveReady,
  type BackupTrigger,
  loadBackup,
  recordFailedSnapshot,
} from '../../backups/persistence.ts'
import type { BackupService } from '../../backups/service.ts'
import { PermanentFailure } from '../../errors.ts'
import type { AccessPolicy } from '../../policy/access-policy.ts'
import type { EventBus } from '../../ports/events.ts'
import type { ArchiveStore } from '../../ports/optional.ts'
import { findServer } from '../../servers/persistence.ts'
import type { OperationHandler } from '../runner.ts'
import type { ServerBinding } from './binding.ts'
import { EXPORT_LINK_SECONDS, type WorldCopies } from './world-copies.ts'

export function backingUp(deps: {
  db: Db
  policy: Pick<AccessPolicy, 'check'>
  events: Pick<EventBus, 'publish'>
  archives: ArchiveStore | null
  backups: Pick<BackupService, 'enforceRetention'>
  bindingOf: ServerBinding['bindingOf']
  capture: WorldCopies['capture']
  pack: WorldCopies['pack']
}) {
  const { db, bindingOf, capture, pack } = deps

  /** A snapshot of whatever the server has now, running or stopped, kept as its owner asked. */
  const backup: OperationHandler = {
    kind: 'backup',
    phase: null,
    runsWhen: ['running', 'stopped'],
    async run(ctx) {
      const server = ctx.server
      const binding = await bindingOf(server.id)
      if (binding.handle === null || binding.applied === null)
        return { status: 'cancelled', reason: 'This server has no world to back up yet.' }
      const trigger = (ctx.op.input.trigger as BackupTrigger) ?? 'manual'
      // Standing or the plan may have changed since it was asked for (§9: re-checked by workers).
      const decision = await db.transaction((tx) =>
        deps.policy.check(tx, server.ownerId, { kind: 'snapshot_backup' }),
      )
      if (!decision.ok) return { status: 'cancelled', reason: decision.message }
      await ctx.step('saving')
      await capture(server, binding.handle, binding.applied, trigger)
      await deps.backups.enforceRetention(server)
      return { status: 'succeeded' }
    },
    /** A backup that failed for good is recorded as one; the server is unaffected (§9). */
    async abandon(op, reason, ended) {
      if (ended !== 'failed') return
      const { applied } = await bindingOf(op.serverId)
      if (applied === null) return
      await db.transaction(async (tx) => {
        await recordFailedSnapshot(tx, {
          serverId: op.serverId,
          worldId: applied.worldId,
          revisionId: applied.revisionId,
          trigger: (op.input.trigger as BackupTrigger) ?? 'manual',
          error: reason,
        })
        const server = await findServer(tx, op.serverId)
        if (server !== null)
          await deps.events.publish(tx, {
            type: 'backup_changed',
            serverId: server.id,
            ownerId: server.ownerId,
          })
      })
    },
  }

  /**
   * A snapshot's world packed into the archive store (§9). The snapshot is left as it was; the
   * archive is offered only once the store holds all of it.
   */
  const archive: OperationHandler = {
    kind: 'archive',
    phase: null,
    runsWhen: [
      'provisioning',
      'stopped',
      'starting',
      'running',
      'stopping',
      'updating',
      'restoring',
      'relocating',
      'failed',
    ],
    async run(ctx) {
      const server = ctx.server
      const input = ctx.op.input as { archiveId: string; snapshotId: string }
      if (deps.archives === null) throw new PermanentFailure('This deployment keeps no archives.')
      // Its snapshot was taken by the provider the server runs on, which must be this one.
      await bindingOf(server.id)
      const target = await loadBackup(db, input.archiveId)
      if (target === null || target.status !== 'pending' || target.archiveKey === null)
        return { status: 'cancelled', reason: 'The archive is no longer wanted.' }
      const snapshot = await loadBackup(db, input.snapshotId)
      if (snapshot === null || snapshot.snapshotHandle === null || snapshot.status !== 'ready')
        throw new PermanentFailure('The backup it was to be made from is gone.')
      await ctx.step('storage')
      const upload = await deps.archives.archiveTarget(target.archiveKey, EXPORT_LINK_SECONDS, 'runtime')
      const exported = await pack(snapshot.snapshotHandle, upload)
      const stored = await deps.archives.head(target.archiveKey)
      if (stored?.sizeBytes !== exported.sizeBytes)
        throw new Error(
          `The store holds ${stored === null ? 'nothing' : `${stored.sizeBytes} bytes`} of the ${exported.sizeBytes} sent`,
        )
      const standing = await loadStanding(db, server.ownerId)
      const days = entitlementsFor(standing.plan, standing.limitOverrides).backupPolicy.archiveRetentionDays
      await db.transaction(async (tx) => {
        await archiveReady(tx, target.id, exported, new Date(Date.now() + days * 86_400_000))
        await deps.events.publish(tx, {
          type: 'backup_changed',
          serverId: server.id,
          ownerId: server.ownerId,
        })
      })
      return { status: 'succeeded' }
    },
    async abandon(op, reason) {
      const { archiveId } = op.input as { archiveId?: string }
      if (archiveId === undefined) return
      await db.transaction(async (tx) => {
        await archiveFailed(tx, archiveId, reason)
        const server = await findServer(tx, op.serverId)
        if (server !== null)
          await deps.events.publish(tx, {
            type: 'backup_changed',
            serverId: server.id,
            ownerId: server.ownerId,
          })
      })
    },
  }

  return { backup, archive }
}
