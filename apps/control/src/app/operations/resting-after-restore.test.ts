// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An owner's restore on a world a connection woke from rest is what comes back after its next
 * rest, though nobody played: the rest makes a copy of the world as restored. Resting again after
 * a visit is `resting-again.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { levelDat } from '../../testing/uploads.ts'

const run = promisify(execFile)

describe.skipIf(!hasDatabase)('resting after a restore', () => {
  let h: Harness
  let scratch: string
  const store = new MemoryStore()

  beforeAll(async () => {
    await store.start()
    scratch = await mkdtemp(join(tmpdir(), 'resting-after-restore-'))
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
  const castle = (id: string) => readFile(h.minecraft.path(id, 'world/built.txt'), 'utf8')
  const rested = async (id: string) => {
    await h.app.schedules.storeSweep()
    await h.until(id, 'stored', 20_000)
    await h.settled(id, 20_000)
  }

  test('the restored world is what comes back from the next rest', async () => {
    const owner = await h.user('Wren')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    // A world of the owner's, brought back as a backup to restore later.
    const bytes = await tarball({
      'server.properties': 'level-name=world\n',
      'world/level.dat': levelDat('26.3'),
      'world/built.txt': 'the castle the owner restored',
    })
    const start = await h.app.backups.beginWorldUpload(owner, id, {
      fileName: 'w.tar.gz',
      sizeBytes: bytes.length,
    })
    await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
    const uploaded = await h.app.backups.finishWorldUpload(owner, id, start.ticket)

    await writeFile(h.minecraft.path(id, 'world/built.txt'), 'the griefed castle')
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 15 * DAY_MS) })
      .where(eq(schema.minecraftServers.id, id))
    await rested(id)

    // A connection wakes it (a server-list ping, a knock): not play, so lastActiveAt stays.
    await h.app.servers.start({ kind: 'system', reason: 'wake' }, id, randomUUID())
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    // The owner, seeing it up, restores their own world over the griefed one.
    await h.app.backups.restoreBackup(owner, id, uploaded.id, randomUUID(), { withConfiguration: false })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect(await castle(id)).toBe('the castle the owner restored')

    // Nobody joins; it sleeps, and rests again.
    await h.app.servers.stop({ kind: 'system', reason: 'idle' }, id, randomUUID(), 'idle')
    await h.until(id, 'stopped', 20_000)
    await h.settled(id, 20_000)
    await rested(id)

    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    expect(await castle(id)).toBe('the castle the owner restored')
  }, 120_000)
})
