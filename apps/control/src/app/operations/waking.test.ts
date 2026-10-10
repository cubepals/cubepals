// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Waking a resting world when a wake fails. A failed wake is settled twice: by the wake, which puts
 * the world back to rest, then by the runner as it records the failure. A join between the two
 * starts the next wake. In production (2026-10-11) the second settling put that wake's server back
 * to rest, and the wake was cancelled as "No longer applies: the server is stored" while the player
 * waited for it. The rest of resting and waking is `storing.test.ts`, which needs a real S3 store.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'

describe.skipIf(!hasDatabase)('waking a resting world', () => {
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

  test('a join as a failed wake is being recorded wakes it again at once, not cancelled', async () => {
    const owner = await h.user('Quinn')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await writeFile(h.minecraft.path(id, 'world/built.txt'), "Quinn's castle")
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 15 * 86_400_000) })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.storeSweep()
    await h.until(id, 'stored', 20_000)
    await h.settled(id, 20_000)

    h.runtime.failRestores('volume already claimed', 'compute')
    const publish = h.events.publish.bind(h.events)
    let joined = false
    const recording = spyOn(h.events, 'publish').mockImplementation(async (tx, event) => {
      const failed = event.type === 'operation_progress' && event.serverId === id && event.status === 'failed'
      if (failed && !joined) {
        joined = true
        h.runtime.failRestores(null)
        await h.app.servers.start(owner, id, randomUUID())
      }
      return publish(tx, event)
    })
    try {
      await h.app.servers.start(owner, id, randomUUID())
      await h.until(id, 'running', 20_000)
      await h.settled(id, 20_000)
    } finally {
      recording.mockRestore()
      h.runtime.failRestores(null)
    }
    const wakes = (await h.operations(id)).filter((op) => op.kind === 'unstore').map((op) => op.status)
    expect(wakes.sort()).toEqual(['failed', 'succeeded'])
    expect(joined).toBe(true)
    expect(await readFile(h.minecraft.path(id, 'world/built.txt'), 'utf8')).toBe("Quinn's castle")
  }, 60_000)
})
