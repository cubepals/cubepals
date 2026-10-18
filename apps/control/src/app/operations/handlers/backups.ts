// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The backups an owner keeps: a snapshot of the server as it is, a restore point of the session a
 * sleep ended, and a snapshot's world packed into the archive store. None touches the server's
 * status: a failure is recorded on the backup, and the server carries on (§9). Putting a backup's
 * world back is `restoring.ts`; how a copy is made is `world-copies.ts`; when a restore point is
 * asked for is `winding-down.ts`'s.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { DAY_MS } from '@blockly/contracts/durations'
import type { AppliedConfigJson, Db } from '@blockly/db'
import { entitlementsFor } from '../../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import {
  archiveFailed,
  archiveReady,
  type BackupTrigger,
  loadBackup,
  recordFailedSnapshot,
} from '../../backups/persistence.ts'
import type { BackupService } from '../../backups/service.ts'
import { inPlainWords, PermanentFailure } from '../../errors.ts'
import type { AccessPolicy } from '../../policy/access-policy.ts'
import type { EventBus } from '../../ports/events.ts'
import type { ArchiveStore } from '../../ports/optional.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import { findServer } from '../../servers/persistence.ts'
import type { OperationHandler, OperationResult } from '../runner.ts'
import type { ServerBinding } from './binding.ts'
import { EXPORT_LINK_SECONDS, type WorldCopies } from './world-copies.ts'

/**
 * How often a restore point being written looks for a start waiting behind it: about what a join
 * may wait on it, against a wake measured at 1.5 s.
 */
const START_WAITING_POLL_MS = 500

interface BackingUpDeps {
  db: Db
  policy: Pick<AccessPolicy, 'check'>
  events: Pick<EventBus, 'publish'>
  archives: ArchiveStore | null
  backups: Pick<BackupService, 'enforceRetention'>
  bindingOf: ServerBinding['bindingOf']
  capture: WorldCopies['capture']
  pack: WorldCopies['pack']
}

/** A backup that failed for good, recorded as one; the server is unaffected (§9). */
async function recordFailure(deps: BackingUpDeps, serverId: string, trigger: BackupTrigger, reason: string) {
  const { applied } = await deps.bindingOf(serverId)
  if (applied === null) return
  await deps.db.transaction(async (tx) => {
    await recordFailedSnapshot(tx, {
      serverId,
      worldId: applied.worldId,
      revisionId: applied.revisionId,
      trigger,
      error: reason,
    })
    const server = await findServer(tx, serverId)
    if (server !== null)
      await deps.events.publish(tx, {
        type: 'backup_changed',
        serverId: server.id,
        ownerId: server.ownerId,
      })
  })
}

/**
 * A restore point of the session a sleep ended. The server stays down until the provider has
 * taken the snapshot, so it holds the world as the game saved it on the way down. Fly then writes
 * it for a minute or so, and a start asked for meanwhile doesn't wait for that: the server is let
 * go, and the restore point is recorded once written. Should this process end first, that one
 * session has no restore point of its own: its world is on the volume, and the next sleep after
 * play takes one.
 */
async function restorePoint(
  deps: BackingUpDeps,
  server: MinecraftServer,
  handle: RuntimeHandle,
  applied: AppliedConfigJson,
): Promise<OperationResult> {
  const taken = Promise.withResolvers<void>()
  const recorded = deps
    .capture(server, handle, applied, 'sleep', false, taken.resolve)
    .then(() => deps.backups.enforceRetention(server))
  await Promise.race([taken.promise, recorded])
  while ((await findServer(deps.db, server.id))?.lifecycle.status !== 'starting') {
    const written = await Promise.race([
      recorded.then(() => true),
      delay(START_WAITING_POLL_MS).then(() => false),
    ])
    if (written) return { status: 'succeeded' }
  }
  void recorded.catch(async (error: unknown) => {
    console.warn(`restore point of ${server.id}, written after it woke: ${inPlainWords(error)}`)
    await recordFailure(deps, server.id, 'sleep', inPlainWords(error)).catch(() => undefined)
  })
  return { status: 'succeeded' }
}

export function backingUp(deps: BackingUpDeps) {
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
      // A restore point holds the world as the game saved it on the way down. One whose server
      // woke first has nothing still to keep: the session goes on, and the next sleep takes one.
      if (trigger === 'sleep' && server.lifecycle.status !== 'stopped')
        return { status: 'cancelled', reason: 'The server woke before its restore point was taken.' }
      // Standing or the plan may have changed since it was asked for (§9: re-checked by workers).
      const decision = await db.transaction((tx) =>
        deps.policy.check(tx, server.ownerId, { kind: 'snapshot_backup' }),
      )
      if (!decision.ok) return { status: 'cancelled', reason: decision.message }
      await ctx.step('saving')
      if (trigger === 'sleep') return restorePoint(deps, server, binding.handle, binding.applied)
      // A stopped server saved its world as it stopped, and its console doesn't answer.
      await capture(server, binding.handle, binding.applied, trigger, server.lifecycle.status === 'running')
      await deps.backups.enforceRetention(server)
      return { status: 'succeeded' }
    },
    async abandon(op, reason, ended) {
      if (ended === 'failed')
        await recordFailure(deps, op.serverId, (op.input.trigger as BackupTrigger) ?? 'manual', reason)
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
        await archiveReady(tx, target.id, exported, new Date(Date.now() + days * DAY_MS))
        await deps.events.publish(tx, {
          type: 'backup_changed',
          serverId: server.id,
          ownerId: server.ownerId,
        })
      })
      // Its snapshot may have been held past the plan's count while this waited.
      await deps.backups.enforceRetention(server, ctx.op.id)
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
