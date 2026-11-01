// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A completed boot or archive must respect a command that changed the server's phase meanwhile. */
import { describe, expect, spyOn, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { DAY_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'

async function deletedAfterBoot() {
  const h = await startHarness()
  const ready = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const realBoot = h.app.boot.run.bind(h.app.boot)
  const held = spyOn(h.app.boot, 'run').mockImplementation(async (...args) => {
    const result = await realBoot(...args)
    ready.resolve()
    await proceed.promise
    return result
  })
  try {
    const owner = await h.user()
    const server = await h.create(owner)
    await ready.promise
    const deleted = await h.app.servers.deleteServer(owner, server.id, server.name)
    expect(deleted.lifecycle.status).not.toBe('provisioning')
    proceed.resolve()
    const operations = await h.settled(server.id)
    expect(operations.find((op) => op.kind === 'provision')?.status).toBe('succeeded')
    expect(operations.find((op) => op.kind === 'decommission')?.status).toBe('succeeded')
    const intervals = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, server.id))
    expect(intervals).toHaveLength(0)
    expect(h.runtime.machine(server.id)?.compute).toBe(false)
  } finally {
    proceed.resolve()
    held.mockRestore()
    await h.close()
  }
}

async function startedAfterCopy() {
  const store = new MemoryStore()
  await store.start()
  const h = await startHarness({ capabilities: { archives: store, billing: null } })
  const verified = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const realVerify = h.app.backups.verifyArchive.bind(h.app.backups)
  const held = spyOn(h.app.backups, 'verifyArchive').mockImplementation(async (...args) => {
    const result = await realVerify(...args)
    verified.resolve()
    await proceed.promise
    return result
  })
  try {
    const owner = await h.user()
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await writeFile(h.minecraft.path(server.id, 'world/kept.txt'), 'The world we built')
    await h.app.servers.stop(owner, server.id, crypto.randomUUID())
    await h.until(server.id, 'stopped')
    await h.settled(server.id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 400 * DAY_MS) })
      .where(eq(schema.minecraftServers.id, server.id))
    expect(await h.app.schedules.storeSweep()).toBe(1)
    await verified.promise
    expect((await h.app.servers.start(owner, server.id, crypto.randomUUID())).lifecycle.status).toBe(
      'starting',
    )
    proceed.resolve()
    await h.until(server.id, 'running')
    const operations = await h.settled(server.id)
    expect(operations.filter((op) => op.kind === 'store').map((op) => op.status)).toEqual(['cancelled'])
    expect(h.runtime.machine(server.id)?.released).toBe(false)
    expect(await readFile(h.minecraft.path(server.id, 'world/kept.txt'), 'utf8')).toBe('The world we built')
    const copies = await h.db.select().from(schema.backups).where(eq(schema.backups.serverId, server.id))
    expect(copies.filter((copy) => copy.tier === 'archive' && copy.status === 'ready')).toHaveLength(1)
  } finally {
    proceed.resolve()
    held.mockRestore()
    await h.close()
    store.close()
  }
}

describe.skipIf(!hasDatabase)('commands racing an operation’s final phase check', () => {
  test('deletion after boot never opens a running interval', deletedAfterBoot, 60 * SECOND_MS)
  test('a start after archive verification keeps the world on its runtime', startedAfterCopy, 60 * SECOND_MS)
})
