// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Restoring one world leaves the server's other worlds as they were: every world it still lists
 * keeps its files, copied back from the snapshot taken just before the restore. A world that
 * can't be copied back stays listed as kept in that snapshot, can't be switched to as if it were
 * there, and comes back when that snapshot is restored.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { levelDat } from '../../testing/uploads.ts'
import { listBackups } from '../backups/persistence.ts'
import { listWorlds } from '../worlds/persistence.ts'

const run = promisify(execFile)

describe.skipIf(!hasDatabase)('restoring one world and the server’s other worlds', () => {
  let h: Harness
  let scratch: string
  const store = new MemoryStore()

  beforeAll(async () => {
    await store.start()
    scratch = await mkdtemp(join(tmpdir(), 'restore-other-worlds-'))
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h?.close()
    store.close()
    await rm(scratch, { recursive: true, force: true })
  })

  const tarball = async (files: Record<string, string | Uint8Array>) => {
    const dir = join(scratch, randomUUID())
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, 'volume', path, '..'), { recursive: true })
      await writeFile(join(dir, 'volume', path), content)
    }
    await run('tar', ['-czf', join(dir, 'world.tar.gz'), '-C', join(dir, 'volume'), '.'])
    return new Uint8Array(await readFile(join(dir, 'world.tar.gz')))
  }

  const restored = async (serverId: string) => {
    await h.until(serverId, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(serverId, 20_000)
  }

  test('a world the server still lists keeps its files after another world is brought back', async () => {
    const owner = await h.user('Kai')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const home = (await h.server(id)).activeWorldId ?? ''
    await writeFile(h.minecraft.path(id, 'world/built.txt'), 'the home world')

    // A world from elsewhere, brought back and restored to play it for a while.
    const bytes = await tarball({
      'server.properties': 'level-name=survival\n',
      'survival/level.dat': levelDat('26.3'),
      'survival/built.txt': 'a world from elsewhere',
    })
    const start = await h.app.backups.beginWorldUpload(owner, id, {
      fileName: 'w.tar.gz',
      sizeBytes: bytes.length,
    })
    await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
    const uploaded = await h.app.backups.finishWorldUpload(owner, id, start.ticket, 'Elsewhere')
    await h.app.backups.restoreBackup(owner, id, uploaded.id, randomUUID(), { withConfiguration: false })
    await restored(id)

    // The home world is still listed, on the volume, and switching back finds it as it was.
    const listed = await h.app.worldQueries.list(owner, id)
    expect(listed.map((w) => [w.name, w.keptInBackupFrom])).toEqual([
      ['World', null],
      ['Elsewhere', null],
    ])
    await h.app.worlds.switchWorld(owner, id, home, randomUUID())
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    expect(await readFile(h.minecraft.path(id, 'world/built.txt'), 'utf8')).toBe('the home world')
  }, 120_000)

  test('a world that can’t be copied back is kept in the snapshot from before, until that is restored', async () => {
    const owner = await h.user('Noor', 'plus')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [backup] = (await listBackups(h.db, id)).filter((b) => b.trigger === 'manual')
    if (backup === undefined) throw new Error('a backup expected')

    // A second world, played after the backup was taken.
    await h.app.worlds.createWorld(
      owner,
      id,
      { name: 'Second', levelType: 'minecraft:normal', hardcore: false },
      randomUUID(),
    )
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    const second = (await h.server(id)).activeWorldId ?? ''
    const level = (await listWorlds(h.db, id)).find((w) => w.id === second)?.levelName ?? ''
    await writeFile(h.minecraft.path(id, `${level}/built.txt`), 'the second world')

    // The first world comes back while nothing can be packed to copy the second one back, and is
    // restored a few times more: more snapshots from before than retention keeps.
    h.runtime.failExports('Packing is not possible right now')
    try {
      for (let i = 0; i < 4; i++) {
        await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false })
        await restored(id)
      }
    } finally {
      h.runtime.failExports(null)
    }
    expect((await h.server(id)).lifecycle.status).toBe('running')
    const kept = (await h.app.worldQueries.list(owner, id)).find((w) => w.id === second)
    expect(kept?.keptInBackupFrom).not.toBeNull()
    await expect(h.app.worlds.switchWorld(owner, id, second, randomUUID())).rejects.toThrow(
      'kept in a backup',
    )

    // It is in the first snapshot from before, taken while it was on the volume, and kept past
    // retention, which keeps the latest few besides.
    const befores = (await listBackups(h.db, id)).filter((b) => b.trigger === 'pre_restore')
    expect(befores.map((b) => b.status)).toEqual(['ready', 'ready', 'ready', 'ready'])
    const before = befores.at(-1)
    if (before === undefined) throw new Error('the snapshot from before the restore expected')

    // Restoring that snapshot brings it back as it was, and nothing says kept any more.
    expect(kept?.keptInBackupFrom).toBe(before.createdAt.toISOString())
    await h.app.backups.restoreBackup(owner, id, before.id, randomUUID(), { withConfiguration: false })
    await restored(id)
    expect(await readFile(h.minecraft.path(id, `${level}/built.txt`), 'utf8')).toBe('the second world')
    const listed = await h.app.worldQueries.list(owner, id)
    expect(listed.map((w) => [w.name, w.keptInBackupFrom])).toEqual([
      ['World', null],
      ['Second', null],
    ])
  }, 120_000)
})
