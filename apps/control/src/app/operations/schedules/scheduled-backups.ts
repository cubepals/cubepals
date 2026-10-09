/**
 * Queues each day's backup of every server played on since its last one, then retires the backups
 * past their lifetime or whose snapshot the provider let go. Weekly archives, and erasing the ones
 * no one can see, are `BackupService`'s (`backups/service.ts`), asked from here; taking a backup is
 * the `backup` operation's (`handlers/backups.ts`).
 */
import type { Db } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { latestBackup, listBackups, pastExpiry, setBackupStatus } from '../../backups/persistence.ts'
import type { BackupService } from '../../backups/service.ts'
import type { EventBus } from '../../ports/events.ts'
import type { SnapshotHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { findServer, listByStatus, loadRuntime } from '../../servers/persistence.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { lastActivity } from '../../servers/usage.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export function schedulingBackups(deps: {
  db: Db
  runtime: Pick<Runtimes, 'providers' | 'goneSnapshots'>
  transitions: Pick<ServerTransitions, 'enqueue'>
  backups: Pick<BackupService, 'scheduleArchives' | 'eraseArchives'>
  events: Pick<EventBus, 'publish'>
}) {
  const { db, runtime, transitions, events } = deps

  /**
   * `backup-schedule` (§9): a daily snapshot of every server played on since its last scheduled
   * one; a server nobody played on keeps its last backup, since nothing in it changed. A weekly
   * archive follows where the plan and the deployment have archives. Then backups past their
   * lifetime, and snapshots the provider has let go, stop being offered, and archives no one can
   * see leave the store.
   */
  const backups = async (now: Date, limit: number): Promise<number> => {
    let queued = 0
    const servers = [...(await listByStatus(db, 'running')), ...(await listByStatus(db, 'stopped'))]
    for (const server of servers) {
      if (queued >= limit) break
      const binding = await loadRuntime(db, server.id, runtime.providers)
      if (binding.handle === null || binding.applied === null) continue
      const last = await latestBackup(db, server.id, 'scheduled')
      if (last !== null && now.getTime() - last.createdAt.getTime() < DAY_MS) continue
      const played = await lastActivity(db, server.id)
      if (played === null || (last !== null && played <= last.createdAt)) continue
      await db.transaction((tx) =>
        transitions.enqueue(tx, server, 'backup', {
          requestedBy: 'system:backup-schedule',
          idempotencyKey: `backup:scheduled:${now.toISOString().slice(0, 10)}`,
          input: { trigger: 'scheduled' },
        }),
      )
      queued++
    }
    queued += await deps.backups.scheduleArchives(servers, now)
    await expireBackups(now, servers)
    await deps.backups.eraseArchives()
    return queued
  }

  const expireBackups = async (now: Date, servers: readonly MinecraftServer[]): Promise<void> => {
    const gone = new Map((await pastExpiry(db, now)).map((b) => [b.id, b]))
    for (const server of servers) {
      const ready = (await listBackups(db, server.id)).filter(
        (b) => b.status === 'ready' && b.snapshotHandle !== null,
      )
      if (ready.length === 0) continue
      // Another provider's snapshots are its own; this deployment can't say whether they're gone.
      if ((await loadRuntime(db, server.id, runtime.providers)).foreign) continue
      // The provider tells its own snapshots apart: a stored handle is only its word for one, and
      // a restore or a move leaves earlier ones on storage the server no longer uses. A provider
      // that can't answer now hides nothing.
      const vanished = await runtime
        .goneSnapshots(ready.flatMap((b) => (b.snapshotHandle === null ? [] : [b.snapshotHandle])))
        .catch(() => new Set<SnapshotHandle>())
      for (const backup of ready)
        if (backup.snapshotHandle !== null && vanished.has(backup.snapshotHandle)) gone.set(backup.id, backup)
    }
    if (gone.size === 0) return
    await db.transaction(async (tx) => {
      await setBackupStatus(tx, [...gone.keys()], 'expired')
      for (const serverId of new Set([...gone.values()].map((b) => b.serverId))) {
        const server = await findServer(tx, serverId)
        if (server) await events.publish(tx, { type: 'backup_changed', serverId, ownerId: server.ownerId })
      }
    })
  }

  return backups
}
