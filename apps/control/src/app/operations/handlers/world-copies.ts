// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Copies of a server's world, each recorded as a backup: a provider snapshot, taken consistent,
 * and a snapshot packed into the archive store and read back before it counts. It makes copies;
 * when one is taken, kept, rested in or restored from is each handler's, and how long backups are
 * kept is `BackupService`'s.
 */
import { randomUUID } from 'node:crypto'
import type { AppliedConfigJson, Db } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { SAVE_ALL_FLUSH, SAVE_OFF, SAVE_ON } from '../../../minecraft/console.ts'
import {
  archiveFailed,
  archiveReady,
  type BackupRecord,
  type BackupTrigger,
  insertArchive,
  loadBackup,
  recordSnapshot,
} from '../../backups/persistence.ts'
import type { BackupService } from '../../backups/service.ts'
import { inPlainWords, PermanentFailure } from '../../errors.ts'
import type { EventBus } from '../../ports/events.ts'
import type { ServerConsole } from '../../ports/minecraft.ts'
import type { ArchiveStore } from '../../ports/optional.ts'
import {
  type ArchiveTarget,
  type RuntimeHandle,
  RuntimeUnsupported,
  type SnapshotHandle,
} from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import type { GameConsole } from './game-console.ts'

/** Packing a large world comes before its upload starts, so an export's link lasts a while. */
export const EXPORT_LINK_SECONDS = 3 * 60 * 60
/** A restore starts downloading its archive as soon as it has the link. */
export const IMPORT_LINK_SECONDS = 60 * 60

/** A world's stored copy, once it has storage again: an ordinary download for a while, then gone. */
export const KEPT_AFTER_WAKING_MS = 7 * 24 * 60 * 60 * 1000

export type WorldCopies = ReturnType<typeof worldCopies>

export function worldCopies(deps: {
  db: Db
  runtime: Pick<Runtimes, 'snapshot' | 'snapshotLifetimeDays' | 'exportSnapshot'>
  console: Pick<ServerConsole, 'run' | 'runAll'>
  consoleTarget: GameConsole['consoleTarget']
  events: Pick<EventBus, 'publish'>
  archives: ArchiveStore | null
  backups: Pick<BackupService, 'verifyArchive'>
}) {
  const { db, runtime, consoleTarget } = deps

  /**
   * A provider snapshot of a running server, taken with saving paused and the world flushed so
   * it is consistent (§15.5), and recorded as a backup of the configuration that was applied.
   */
  const capture = async (
    server: MinecraftServer,
    handle: RuntimeHandle,
    config: AppliedConfigJson,
    trigger: BackupTrigger,
    /** A stopped server saved its world as it stopped: there is nothing to pause or flush. */
    running = true,
  ): Promise<BackupRecord> => {
    const target = consoleTarget(server, handle)
    if (running) await deps.console.runAll(target, [SAVE_OFF, SAVE_ALL_FLUSH]).catch(() => undefined)
    try {
      const taken = await runtime.snapshot(handle)
      const lifetime = runtime.snapshotLifetimeDays(taken.snapshot)
      const backup = await recordSnapshot(db, {
        serverId: server.id,
        worldId: config.worldId,
        revisionId: config.revisionId,
        trigger,
        snapshot: taken.snapshot,
        sizeBytes: taken.sizeBytes,
        expiresAt: lifetime === null ? null : new Date(taken.at.getTime() + lifetime * 86_400_000),
      })
      await db.transaction((tx) =>
        deps.events.publish(tx, { type: 'backup_changed', serverId: server.id, ownerId: server.ownerId }),
      )
      return backup
    } finally {
      if (running) await deps.console.run(target, SAVE_ON).catch(() => undefined)
    }
  }

  /**
   * A snapshot's world packed into the store at `target`. One its runtime can't pack at all (a
   * world too big for a single upload) fails at once: every try would pack it whole again.
   */
  const pack = async (snapshot: SnapshotHandle, target: ArchiveTarget) => {
    try {
      return await runtime.exportSnapshot(snapshot, target)
    } catch (error) {
      if (!(error instanceof RuntimeUnsupported)) throw error
      throw new PermanentFailure('This world is too big to pack into one archive.', { cause: error })
    }
  }

  /**
   * A stopped server's world packed into the archive store, and read back as far as its settings
   * and its world's level.dat before it counts: the one copy of a world any runtime can restore.
   */
  const archiveCopy = async (
    server: MinecraftServer,
    handle: RuntimeHandle,
    config: AppliedConfigJson,
    trigger: 'stored' | 'pre_relocate',
  ): Promise<BackupRecord> => {
    const archives = deps.archives
    if (archives === null) throw new PermanentFailure('This deployment keeps no archives.')
    const snapshot = await capture(server, handle, config, trigger, false)
    if (snapshot.snapshotHandle === null) throw new Error('The snapshot has no handle')
    const id = randomUUID()
    const key = archives.newKey('archive', { serverId: server.id, id })
    const copy = await insertArchive(db, {
      id,
      serverId: server.id,
      worldId: config.worldId,
      revisionId: config.revisionId,
      trigger,
      archiveKey: key,
    })
    try {
      const exported = await pack(
        snapshot.snapshotHandle,
        await archives.archiveTarget(key, EXPORT_LINK_SECONDS, 'runtime'),
      )
      const held = await archives.head(key)
      if (held?.sizeBytes !== exported.sizeBytes)
        throw new Error(
          `The store holds ${held === null ? 'nothing' : `${held.sizeBytes} bytes`} of the ${exported.sizeBytes} sent`,
        )
      await deps.backups.verifyArchive(key)
      await archiveReady(db, copy.id, exported, null)
    } catch (error) {
      await archiveFailed(db, copy.id, inPlainWords(error))
      throw error
    }
    const ready = await loadBackup(db, copy.id)
    if (ready === null || ready.status !== 'ready') throw new Error('The copy just made is missing')
    return ready
  }

  return { capture, pack, archiveCopy }
}
