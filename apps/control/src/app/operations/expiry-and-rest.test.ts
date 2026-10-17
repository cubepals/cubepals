// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The daily backups sweep and a rest at the same time: the sweep reads what is due, asks the
 * provider about each server's snapshots, then retires what it read. What a world rests in by
 * then, or what was kept for longer meanwhile, stays.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { loadBackup, setExpiry, storedCopy } from '../backups/persistence.ts'

describe.skipIf(!hasDatabase)('the expiry sweep beside a rest', () => {
  let h: Harness
  const store = new MemoryStore()

  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
    // A bystander with a snapshot, so the sweep asks the provider about something.
    const other = await h.user('Bea')
    const bystander = await h.create(other)
    await h.until(bystander.id, 'running')
    await h.settled(bystander.id)
    await h.app.backups.createBackup(other, bystander.id, randomUUID())
    await h.settled(bystander.id)
  }, 60_000)

  afterAll(async () => {
    await h?.close()
    store.close()
  })

  /** A world rested once, woken by a knock nobody followed, asleep again: its first copy kept a week. */
  const restedAndWoken = async (name: string) => {
    const owner = await h.user(name)
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await writeFile(h.minecraft.path(id, 'world/built.txt'), `${name}'s castle`)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 15 * DAY_MS) })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.storeSweep()
    await h.until(id, 'stored', 20_000)
    await h.settled(id, 20_000)
    await h.app.servers.start({ kind: 'system', reason: 'wake' }, id, randomUUID())
    await h.until(id, 'running', 20_000)
    await h.settled(id, 20_000)
    await h.app.servers.stop({ kind: 'system', reason: 'idle' }, id, randomUUID(), 'idle')
    await h.until(id, 'stopped', 20_000)
    await h.settled(id, 20_000)
    const copy = await storedCopy(h.db, id)
    if (copy === null) throw new Error('no stored copy')
    return { owner, id, copy }
  }

  /** Runs `meanwhile` while the sweep, having read what is due, waits on the provider. */
  const sweepAround = async (meanwhile: () => Promise<void>) => {
    const asked = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<void>()
    const gone = h.runtime.goneSnapshots.bind(h.runtime)
    const slow = spyOn(h.runtime, 'goneSnapshots').mockImplementation(async (snapshots) => {
      asked.resolve()
      await answer.promise
      return gone(snapshots)
    })
    try {
      const sweep = h.app.schedules.backups()
      await asked.promise
      await meanwhile()
      answer.resolve()
      await sweep
    } finally {
      answer.resolve()
      slow.mockRestore()
    }
  }

  test('a world put to rest while the sweep runs keeps the copy it rests in', async () => {
    const { owner, id, copy } = await restedAndWoken('Ivo')
    // Its week has passed (resting was paused meanwhile, or each try failed): the copy is due.
    await setExpiry(h.db, copy.id, new Date(Date.now() - MINUTE_MS))

    await sweepAround(async () => {
      await h.app.schedules.storeSweep()
      await h.until(id, 'stored', 20_000)
      await h.settled(id, 20_000)
    })
    const resting = await storedCopy(h.db, id)
    expect(resting?.expiresAt).toBeNull()
    expect(resting?.archiveKey && (await store.head(resting.archiveKey))).toBeTruthy()

    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect(await readFile(h.minecraft.path(id, 'world/built.txt'), 'utf8')).toBe("Ivo's castle")
  }, 120_000)

  test('a backup kept for good after the sweep read it as due stays', async () => {
    const { copy } = await restedAndWoken('Ode')
    await setExpiry(h.db, copy.id, new Date(Date.now() - MINUTE_MS))
    await sweepAround(() => setExpiry(h.db, copy.id, null))
    expect((await loadBackup(h.db, copy.id))?.status).toBe('ready')
  }, 120_000)
})
