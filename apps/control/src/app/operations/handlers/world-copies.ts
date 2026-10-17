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
import { setTimeout as delay } from 'node:timers/promises'
import { DAY_MS, HOUR_S, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
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
import type { ConsoleTarget, ServerConsole } from '../../ports/minecraft.ts'
import type { ArchiveStore } from '../../ports/optional.ts'
import {
  type ArchiveTarget,
  type RuntimeHandle,
  RuntimeUnsupported,
  type SnapshotHandle,
} from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { NoLongerApplies } from '../runner.ts'
import type { GameConsole } from './game-console.ts'

/** Packing a large world comes before its upload starts, so an export's link lasts a while. */
export const EXPORT_LINK_SECONDS = 3 * HOUR_S
/** A restore starts downloading its archive as soon as it has the link. */
export const IMPORT_LINK_SECONDS = HOUR_S

/** A world's stored copy, once it has storage again: an ordinary download for a while, then gone. */
export const KEPT_AFTER_WAKING_MS = 7 * DAY_MS

/** A big world's flush can outlast the console's usual wait for one command; asked again, it gets this. */
const FLUSH_AGAIN_MS = 2 * MINUTE_MS
/** Between tries at turning saving back on: a console that dropped the connection is soon back. */
const SAVE_ON_AGAIN_MS = [SECOND_MS, 2 * SECOND_MS, 4 * SECOND_MS, 8 * SECOND_MS]

/** On a snapshot taken while the game may still have been writing its world. */
export const NOT_SAVED_FIRST =
  "The game hadn't finished saving when this was taken, so it isn't offered as a restore point."

export type WorldCopies = ReturnType<typeof worldCopies>

export function worldCopies(deps: {
  db: Db
  runtime: Pick<Runtimes, 'snapshot' | 'snapshotLifetimeDays' | 'exportSnapshot' | 'observe'>
  console: Pick<ServerConsole, 'run' | 'runAll'>
  consoleTarget: GameConsole['consoleTarget']
  events: Pick<EventBus, 'publish'>
  archives: ArchiveStore | null
  backups: Pick<BackupService, 'verifyArchive'>
}) {
  const { db, runtime, consoleTarget } = deps

  /**
   * Saving paused and the world flushed, as the game answered: false where it never said both
   * were done. A flush that ran out of time is asked for once more, with longer: a second
   * `save-all flush` waits for the first to finish, and the game has little left to write.
   */
  const paused = async (target: ConsoleTarget): Promise<boolean> => {
    const first = await deps.console.runAll(target, [SAVE_OFF, SAVE_ALL_FLUSH]).catch(() => null)
    if (first?.every((result) => result.ok)) return true
    const again = await deps.console
      .runAll(target, [SAVE_OFF, SAVE_ALL_FLUSH], { commandMs: FLUSH_AGAIN_MS })
      .catch(() => null)
    return again?.every((result) => result.ok) === true
  }

  /**
   * Saving back on, tried again a few times: a server left with it off loses everything played
   * since, should it crash. One the console still drops is owed, and `runtimes/owed-saving.ts`
   * sends it before the server's next command.
   */
  const resumed = async (server: MinecraftServer, target: ConsoleTarget): Promise<void> => {
    for (const wait of [0, ...SAVE_ON_AGAIN_MS]) {
      await delay(wait)
      const on = await deps.console.run(target, SAVE_ON).then(
        () => true,
        () => false,
      )
      if (on) return
    }
    console.warn(`${server.id} still saves nothing after its snapshot: save-on goes with its next command`)
  }

  /**
   * A provider snapshot of a running server, taken with saving paused and the world flushed so
   * it is consistent (§15.5), and recorded as a backup of the configuration that was applied.
   * One the game never said it had flushed is kept, for the operation that took it to go back
   * to, but recorded failed: it isn't offered as a restore point or counted among those kept.
   */
  const capture = async (
    server: MinecraftServer,
    handle: RuntimeHandle,
    config: AppliedConfigJson,
    trigger: BackupTrigger,
    /** A stopped server saved its world as it stopped: there is nothing to pause or flush. */
    running = true,
    /** Told once the provider holds the moment it copies, as `MinecraftRuntime.snapshot` says. */
    taken?: () => void,
  ): Promise<BackupRecord> => {
    const target = consoleTarget(server, handle)
    // A compute that isn't running has no game to pause: its disk holds what the game last wrote.
    const live =
      running &&
      (await runtime.observe(handle).then(
        (seen) => seen.state === 'running',
        () => true,
      ))
    const saved = live ? await paused(target) : true
    try {
      const made = await runtime.snapshot(handle, taken)
      const lifetime = runtime.snapshotLifetimeDays(made.snapshot)
      const backup = await recordSnapshot(db, {
        serverId: server.id,
        worldId: config.worldId,
        revisionId: config.revisionId,
        trigger,
        snapshot: made.snapshot,
        sizeBytes: made.sizeBytes,
        expiresAt: lifetime === null ? null : new Date(made.at.getTime() + lifetime * DAY_MS),
        error: saved ? null : NOT_SAVED_FIRST,
      })
      await db.transaction((tx) =>
        deps.events.publish(tx, { type: 'backup_changed', serverId: server.id, ownerId: server.ownerId }),
      )
      return backup
    } finally {
      if (live) await resumed(server, target)
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
    /**
     * Asked once the snapshot is taken, before the long part, packing it: false ends the copy
     * there, as `NoLongerApplies`. The world is untouched and the snapshot stays as a backup.
     */
    stillApplies: () => Promise<boolean> = async () => true,
  ): Promise<BackupRecord> => {
    const archives = deps.archives
    if (archives === null) throw new PermanentFailure('This deployment keeps no archives.')
    const snapshot = await capture(server, handle, config, trigger, false)
    if (snapshot.snapshotHandle === null) throw new Error('The snapshot has no handle')
    if (!(await stillApplies())) throw new NoLongerApplies()
    return packed(archives, server, config, trigger, snapshot.snapshotHandle)
  }

  /** `snapshot` packed into `archives` and read back, recorded as the copy it makes. */
  const packed = async (
    archives: ArchiveStore,
    server: MinecraftServer,
    config: AppliedConfigJson,
    trigger: 'stored' | 'pre_relocate',
    snapshot: SnapshotHandle,
  ): Promise<BackupRecord> => {
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
      const exported = await pack(snapshot, await archives.archiveTarget(key, EXPORT_LINK_SECONDS, 'runtime'))
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
