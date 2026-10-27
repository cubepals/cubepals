// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One world upload is one backup, however many times its finish is asked for at once (a browser
 * retrying a slow finish): each answer is that backup, and no other backup can point at its file,
 * so deleting a backup never erases a world another one still lists.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { levelDat } from '../../testing/uploads.ts'
import { untilRead } from '../../testing/world-imports.ts'
import { insertArchive, listBackups } from './persistence.ts'

const run = promisify(execFile)

describe.skipIf(!hasDatabase)('one world upload finished twice at once', () => {
  let h: Harness
  let scratch: string
  const store = new MemoryStore()

  beforeAll(async () => {
    await store.start()
    scratch = await mkdtemp(join(tmpdir(), 'upload-finished-twice-'))
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h?.close()
    store.close()
    await rm(scratch, { recursive: true, force: true })
  })

  const tarball = async (files: Record<string, string | Uint8Array>) => {
    const dir = join(scratch, crypto.randomUUID())
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, 'volume', path, '..'), { recursive: true })
      await writeFile(join(dir, 'volume', path), content)
    }
    await run('tar', ['-czf', join(dir, 'world.tar.gz'), '-C', join(dir, 'volume'), '.'])
    return new Uint8Array(await readFile(join(dir, 'world.tar.gz')))
  }

  test('a ticket becomes one backup, and deleting a backup never erases another’s world', async () => {
    const owner = await h.user('Uma')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const bytes = await tarball({
      'server.properties': 'level-name=world\n',
      'world/level.dat': levelDat('26.3'),
      'world/built.txt': 'the uploaded castle',
    })
    const start = await h.app.backups.beginWorldUpload(owner, id, {
      fileName: 'world.tar.gz',
      sizeBytes: bytes.length,
    })
    await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })

    // The browser asks again, as it does when an answer is slow: the same import, read once.
    const finishes = await Promise.all([
      h.app.backups.finishWorldUpload(owner, id, start.ticket),
      h.app.backups.finishWorldUpload(owner, id, start.ticket),
    ])
    expect(finishes).toEqual([{ importId: start.ticket }, { importId: start.ticket }])
    const view = await untilRead(h, owner, id, start.ticket)
    const uploaded = (await listBackups(h.db, id)).filter((b) => b.trigger === 'uploaded')
    expect(uploaded).toHaveLength(1)
    const [only] = uploaded
    if (only === undefined) throw new Error('the uploaded backup expected')
    expect(view).toMatchObject({ status: 'ready', backupId: only.id })
    // Asked again once it is kept, it is the same import still.
    expect(await h.app.backups.finishWorldUpload(owner, id, start.ticket)).toEqual({ importId: start.ticket })

    // No second backup can point at its file, so deleting one never erases another's world.
    const again = insertArchive(h.db, {
      id: crypto.randomUUID(),
      serverId: id,
      worldId: only.worldId,
      revisionId: only.revisionId,
      trigger: 'uploaded',
      archiveKey: only.archiveKey ?? '',
    })
    await expect(again).rejects.toThrow()
  }, 60_000)
})
