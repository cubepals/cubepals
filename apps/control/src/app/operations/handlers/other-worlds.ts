// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server's other worlds through a restore. A restore puts a backup's whole volume in place,
 * so every world the server lists besides the one restored is copied back, as it was, from the
 * snapshot taken just before. A world that can't be stays in that snapshot, listed as kept there
 * until it is restored from it. Taking the snapshot and the restore itself are `restoring.ts`'s.
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { HOUR_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { Db, Tx } from '@blockly/db'
import { bringWorldsBackCommand, WORLDS_BACK, worldDirectories } from '../../../minecraft/worlds.ts'
import type { BackupRecord } from '../../backups/persistence.ts'
import type { BackupService } from '../../backups/service.ts'
import type { ArchiveStore } from '../../ports/optional.ts'
import type { RuntimeHandle, SnapshotHandle } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import {
  keepWorldsIn,
  keptWorlds,
  listWorlds,
  setWorldFacts,
  type WorldRecord,
  worldsBack,
  worldsBackFrom,
} from '../../worlds/persistence.ts'
import { EXPORT_LINK_SECONDS, IMPORT_LINK_SECONDS, type WorldCopies } from './world-copies.ts'

/** How often the copy is asked how it went. */
const ASKED_EVERY_MS = 2 * SECOND_MS
/** A copy not done by then counts as failed: its worlds stay in the snapshot. */
const COPYING_AT_MOST_MS = 2 * HOUR_MS

export function otherWorlds(deps: {
  db: Db
  runtime: Pick<Runtimes, 'exec'>
  archives: ArchiveStore | null
  backups: Pick<BackupService, 'topLevelOf'>
  pack: WorldCopies['pack']
}) {
  const { runtime } = deps

  /**
   * Every world the server lists besides those `restored` brings back, which a restore leaves as
   * it is: its own world, and every world kept in it, which comes back from it as it was kept.
   */
  const besides = async (serverId: string, restored: BackupRecord): Promise<WorldRecord[]> => {
    const kept = await keptWorlds(deps.db, serverId)
    return (await listWorlds(deps.db, serverId)).filter(
      (w) => w.deletedAt === null && w.id !== restored.worldId && kept.get(w.id) !== restored.id,
    )
  }

  /** Whether the copy the server was handed finished well, asked until it says or time is up. */
  const finished = async (handle: RuntimeHandle): Promise<boolean> => {
    for (const until = Date.now() + COPYING_AT_MOST_MS; Date.now() < until; ) {
      await sleep(ASKED_EVERY_MS)
      const said = (await runtime.exec(handle, WORLDS_BACK, 60).catch(() => null))?.stdout.trim()
      if (said !== undefined && said !== '') return said === '0'
    }
    return false
  }

  /** `others`' directories that `snapshot` holds, packed at `key` and unpacked on the server. */
  const copied = async (
    handle: RuntimeHandle,
    archives: ArchiveStore,
    key: string,
    snapshot: SnapshotHandle,
    others: readonly WorldRecord[],
  ): Promise<boolean> => {
    await deps.pack(snapshot, await archives.archiveTarget(key, EXPORT_LINK_SECONDS, 'runtime'))
    // A world that had no directories before has none to copy back.
    const held = await deps.backups.topLevelOf(key)
    const directories = others.flatMap((w) => worldDirectories(w.levelName)).filter((d) => held.has(d))
    if (directories.length === 0) return true
    const link = await archives.presignGet(key, IMPORT_LINK_SECONDS, 'runtime')
    const started = await runtime.exec(handle, bringWorldsBackCommand(link.url, directories), 60)
    return started.exitCode === 0 && (await finished(handle))
  }

  /**
   * `others`' directories copied onto the running server from `before`, the snapshot taken just
   * before the restore. Returns the worlds it couldn't copy back. It never throws: the restore
   * itself went through.
   */
  const bringBack = async (
    handle: RuntimeHandle,
    before: BackupRecord,
    others: readonly WorldRecord[],
  ): Promise<WorldRecord[]> => {
    const archives = deps.archives
    if (others.length === 0) return []
    if (archives === null || before.snapshotHandle === null) return [...others]
    const key = archives.newKey('archive', { serverId: before.serverId, id: randomUUID() })
    try {
      return (await copied(handle, archives, key, before.snapshotHandle, others)) ? [] : [...others]
    } catch {
      return [...others]
    } finally {
      await archives.delete(key).catch(() => undefined)
    }
  }

  /**
   * Recorded as the restore ends: the world restored, and every world kept in `restored`, is on
   * the volume again, the restored one as its files describe it; each world in `left` is kept in
   * `before`, which the page says, until restored from there.
   */
  const settle = async (
    tx: Tx,
    restored: BackupRecord,
    left: readonly WorldRecord[],
    before: BackupRecord,
  ) => {
    await worldsBack(tx, [restored.worldId])
    await worldsBackFrom(tx, restored.id)
    // An uploaded world is the one its files describe, whatever its row said before.
    if (restored.worldFacts !== null) await setWorldFacts(tx, restored.worldId, restored.worldFacts)
    await keepWorldsIn(
      tx,
      left.map((w) => w.id),
      before.id,
    )
  }

  return { besides, bringBack, settle }
}
