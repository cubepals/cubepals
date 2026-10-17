// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world kept in a snapshot while another world ran, because a restore couldn't copy it back,
 * comes back from that snapshot as it was kept when the snapshot is restored, and is not kept any
 * more: the restore leaves it out of the worlds it copies back from the newer snapshot.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { listBackups } from '../backups/persistence.ts'
import { listWorlds } from '../worlds/persistence.ts'

describe.skipIf(!hasDatabase)('restoring a snapshot that worlds are kept in', () => {
  let h: Harness
  const store = new MemoryStore()

  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h?.close()
    store.close()
  })

  const restored = async (serverId: string) => {
    await h.until(serverId, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(serverId, 20_000)
  }

  test('a world kept in a snapshot while another ran comes back from that snapshot, as it was', async () => {
    const owner = await h.user('Ines', 'plus')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const home = (await h.server(id)).activeWorldId ?? ''
    const play = async (worldId: string) => {
      await h.app.worlds.switchWorld(owner, id, worldId, randomUUID())
      await h.until(id, 'running', 20_000)
      await h.settled(id, 20_000)
    }
    const made = async (name: string) => {
      await h.app.worlds.createWorld(
        owner,
        id,
        { name, levelType: 'minecraft:normal', hardcore: false },
        randomUUID(),
      )
      await h.until(id, 'running', 20_000)
      await h.settled(id, 20_000)
      const worldId = (await h.server(id)).activeWorldId ?? ''
      const level = (await listWorlds(h.db, id)).find((w) => w.id === worldId)?.levelName ?? ''
      return { worldId, level }
    }

    // Three worlds: the backup of the third holds the second as it was then.
    const idle = await made('Idle')
    await writeFile(h.minecraft.path(id, `${idle.level}/built.txt`), 'the idle world, early on')
    const third = await made('Third')
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const thirds = (await listBackups(h.db, id)).find(
      (b) => b.trigger === 'manual' && b.worldId === third.worldId,
    )
    if (thirds === undefined) throw new Error('a backup of the third world expected')
    await play(idle.worldId)
    await writeFile(h.minecraft.path(id, `${idle.level}/built.txt`), 'the idle world, as it is now')
    await play(home)

    // The third world comes back while nothing can be packed: the first and the idle one are kept.
    h.runtime.failExports('Packing is not possible right now')
    try {
      await h.app.backups.restoreBackup(owner, id, thirds.id, randomUUID(), { withConfiguration: false })
      await restored(id)
    } finally {
      h.runtime.failExports(null)
    }
    const before = (await listBackups(h.db, id)).find((b) => b.trigger === 'pre_restore')
    if (before === undefined) throw new Error('the snapshot from before the restore expected')
    const keptIn = async () =>
      Object.fromEntries((await h.app.worldQueries.list(owner, id)).map((w) => [w.name, w.keptInBackupFrom]))
    expect(await keptIn()).toEqual({
      World: before.createdAt.toISOString(),
      Idle: before.createdAt.toISOString(),
      Third: null,
    })

    // Restoring that snapshot brings both back as they were, and nothing says kept any more.
    await h.app.backups.restoreBackup(owner, id, before.id, randomUUID(), { withConfiguration: false })
    await restored(id)
    expect(await keptIn()).toEqual({ World: null, Idle: null, Third: null })
    await play(idle.worldId)
    expect(await readFile(h.minecraft.path(id, `${idle.level}/built.txt`), 'utf8')).toBe(
      'the idle world, as it is now',
    )
  }, 180_000)
})
