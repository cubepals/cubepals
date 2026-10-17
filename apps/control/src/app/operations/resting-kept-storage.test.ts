// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server keeping the storage a rebuild moved it off (`servers/kept-storage.ts`) doesn't rest
 * until that storage goes: a rest lets go of every disk the server has, the kept one with it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import { KEEP_MS, keepStorage, keptStorage } from '../servers/kept-storage.ts'

describe.skipIf(!hasDatabase)('resting a server that keeps a rebuild’s storage', () => {
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

  test('waits until the kept storage goes, then rests', async () => {
    const owner = await h.user('Kit')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 15 * DAY_MS) })
      .where(eq(schema.minecraftServers.id, id))
    // Its host couldn't run it: rebuilt elsewhere, the old storage kept.
    await keepStorage(h.db, id, 'old-storage' as RuntimeHandle, new Date())

    expect(await h.app.schedules.storeSweep()).toBe(0)
    // Asked for at once, it is called off, and says why.
    await h.app.servers.upkeep.rest({ kind: 'operator', name: 'ada' }, id, randomUUID())
    await h.settled(id, 20_000)
    const asked = (await h.operations(id)).find((op) => op.kind === 'store')
    expect(asked?.status).toBe('cancelled')
    expect(asked?.error).toContain('before a rebuild')
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    expect(await keptStorage(h.db, id, new Date())).toEqual(['old-storage' as RuntimeHandle])

    // Once its week is over, the next sweep rests it.
    expect(await h.app.schedules.storeSweep(new Date(Date.now() + KEEP_MS + DAY_MS))).toBe(1)
    await h.until(id, 'stored', 20_000)
    await h.settled(id, 20_000)
  }, 60_000)
})
