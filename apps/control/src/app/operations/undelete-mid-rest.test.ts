// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server sent to the trash while its world is being put to rest, and taken back out before the
 * rest finishes letting its storage go, comes back resting and wakes from its copy: whether the
 * undelete saw the rest letting go, or the rest's last step finds it back asleep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'

describe.skipIf(!hasDatabase)('taking a server out of the trash mid-rest', () => {
  const store = new MemoryStore()
  let h: Harness

  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h?.close()
    store.close()
  })

  const ops = schema.serverOperations
  const restOf = (id: string) => and(eq(ops.serverId, id), eq(ops.kind, 'store'))

  /** A server whose rest has its copy and is letting go of its storage, held there. */
  const midRest = async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 400 * DAY_MS) })
      .where(eq(schema.minecraftServers.id, id))
    const letGo = h.runtime.holdReleases(1)
    expect(await h.app.schedules.storeSweep()).toBe(1)
    await h.until(id, 'storing', 20_000)
    for (let tries = 0; tries < 100; tries++) {
      const [rest] = await h.db.select({ progress: ops.progress }).from(ops).where(restOf(id))
      if (rest?.progress?.step === 'storage') break
      await Bun.sleep(50)
    }
    return { owner, id, letGo }
  }

  const wakes = async (owner: Awaited<ReturnType<typeof midRest>>['owner'], id: string) => {
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, (s) => !['starting', 'restoring'].includes(s.lifecycle.status), 30_000)
    await h.settled(id, 30_000)
    await Bun.sleep(SECOND_MS)
    expect((await h.server(id)).lifecycle.status).toBe('running')
  }

  test('taken back while the rest lets go, it comes back resting, and wakes', async () => {
    const { owner, id, letGo } = await midRest()
    try {
      await h.app.servers.deleteServer(owner, id, (await h.server(id)).name)
      expect((await h.app.servers.undeleteServer(owner, id)).lifecycle.status).toBe('stored')
    } finally {
      letGo()
    }
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('stored')
    await wakes(owner, id)
  }, 90_000)

  test('taken back asleep, the rest finishing finds it so and rests it, and it wakes', async () => {
    const { owner, id, letGo } = await midRest()
    try {
      await h.app.servers.deleteServer(owner, id, (await h.server(id)).name)
      // As if taken back the moment before the rest said it was letting go.
      await h.db.update(ops).set({ progress: null }).where(restOf(id))
      expect((await h.app.servers.undeleteServer(owner, id)).lifecycle.status).toBe('stopped')
    } finally {
      letGo()
    }
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('stored')
    const audit = await h.db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'server.stored_after_undelete')),
      )
    expect(audit).toHaveLength(1)
    await wakes(owner, id)
  }, 90_000)

  test('taken back while the rest lets go, and the release fails for good, it still rests and wakes', async () => {
    const { owner, id, letGo } = await midRest()
    try {
      h.runtime.failReleases('the provider went away', { partway: true })
      await h.app.servers.deleteServer(owner, id, (await h.server(id)).name)
      expect((await h.app.servers.undeleteServer(owner, id)).lifecycle.status).toBe('stored')
    } finally {
      letGo()
    }
    await h.settled(id, 30_000)
    const rested = await h.server(id)
    expect(rested.lifecycle.status).toBe('stored')
    expect(rested.storedAt).not.toBeNull()
    h.runtime.failReleases(null)
    await wakes(owner, id)
  }, 90_000)
})
