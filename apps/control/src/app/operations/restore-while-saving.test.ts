// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A restore saves the server's world while the backup comes: the backup's storage is filled while
 * the snapshot of the world it replaces is still being taken, and nothing is replaced until that
 * snapshot is kept. A save that fails leaves the server's world and storage as they were, with
 * nothing the restore made left behind.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { listBackups } from '../backups/persistence.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import { loadRuntime } from '../servers/persistence.ts'

describe.skipIf(!hasDatabase)('a restore that saves the world while the backup comes', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  /** A running server with a backup of its world, and its world changed since. */
  const backedUp = async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await writeFile(h.minecraft.path(id, 'world/built.txt'), 'as the backup has it')
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [backup] = (await listBackups(h.db, id)).filter((b) => b.status === 'ready')
    if (backup === undefined) throw new Error('No backup was taken')
    await writeFile(h.minecraft.path(id, 'world/built.txt'), 'as it is now')
    return { owner, id, backup }
  }

  /** What the server's world says now. */
  const built = (id: string) => readFile(h.minecraft.path(id, 'world/built.txt'), 'utf8')

  /** The volumes the fake holds for the server: its own, and any a restore is filling. */
  const volumes = async (id: string) =>
    (await readdir(dirname(h.minecraft.path(id, '')))).filter((name) => name.startsWith('volume-'))

  /** The steps and marks the server's latest restore recorded, in order. */
  const recorded = async (id: string) => {
    const [op] = await h.db
      .select({ steps: schema.serverOperations.steps })
      .from(schema.serverOperations)
      .where(and(eq(schema.serverOperations.serverId, id), eq(schema.serverOperations.kind, 'restore')))
      .orderBy(schema.serverOperations.createdAt)
      .then((ops) => ops.slice(-1))
    return (op?.steps ?? []).map((s) => s.step)
  }

  const until = async (what: () => Promise<boolean>) => {
    for (const deadline = Date.now() + 10_000; !(await what()); await Bun.sleep(20))
      if (Date.now() > deadline) throw new Error('It never happened')
  }

  /** The runtime's snapshots wait for `held`, then go on as `then` says. */
  const holdSnapshots = (held: Promise<void>, then: 'take' | 'fail') => {
    const take = h.runtime.snapshot.bind(h.runtime)
    return spyOn(h.runtime, 'snapshot').mockImplementation(async (handle: RuntimeHandle) => {
      await held
      if (then === 'fail') throw new Error('the volume is busy')
      return take(handle)
    })
  }

  test('the backup is fetched while the world is saved, and replaces it only once it is kept', async () => {
    const { owner, id, backup } = await backedUp()
    let release = () => {}
    const snapshot = holdSnapshots(new Promise((resolve) => (release = resolve)), 'take')
    try {
      await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false })
      // The snapshot is still being taken, and the backup's storage is already filled beside it.
      await until(async () => (await volumes(id)).length === 2)
      await Bun.sleep(200)
      expect(snapshot).toHaveBeenCalled()
      expect(await recorded(id)).toContain('storage')
      expect(await recorded(id)).not.toContain('compute')
      expect(await built(id)).toBe('as it is now')
      release()
      await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
      await h.settled(id, 20_000)
    } finally {
      snapshot.mockRestore()
    }

    expect((await h.operations(id)).filter((o) => o.kind === 'restore').at(-1)?.status).toBe('succeeded')
    expect(await built(id)).toBe('as the backup has it')
    expect(await volumes(id)).toHaveLength(1)
    const steps = await recorded(id)
    expect(steps.filter((s) => ['saving', 'storage', 'saved', 'compute'].includes(s))).toEqual([
      'saving',
      'storage',
      'saved',
      'compute',
    ])
    const before = (await listBackups(h.db, id)).find((b) => b.trigger === 'pre_restore')
    expect(before?.status).toBe('ready')
  }, 60_000)

  test('a save that fails leaves the world and storage as they were, and nothing behind', async () => {
    const { owner, id, backup } = await backedUp()
    const { handle } = await loadRuntime(h.db, id, ['fake'])
    let release = () => {}
    const snapshot = holdSnapshots(new Promise((resolve) => (release = resolve)), 'fail')
    try {
      await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false })
      await until(async () => (await volumes(id)).length === 2)
      release()
      await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
      await h.settled(id, 20_000)
    } finally {
      snapshot.mockRestore()
    }

    const restore = (await h.operations(id)).filter((o) => o.kind === 'restore').at(-1)
    expect(restore).toMatchObject({ status: 'failed', detail: expect.stringContaining('the volume is busy') })
    expect((await loadRuntime(h.db, id, ['fake'])).handle).toBe(handle)
    expect(await built(id)).toBe('as it is now')
    expect(await volumes(id)).toHaveLength(1)
    expect(await recorded(id)).not.toContain('compute')
  }, 60_000)
})
