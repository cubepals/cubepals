// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { LogSource } from '../ports/platform.ts'
import { ConsoleFeed } from './feed.ts'

// A console that opens mid-game shows what came before (§13): the server's recent output,
// classified the way the live tail is.
describe.skipIf(!hasDatabase)('console history', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('the last lines a running server printed, newest last, as the console shows them', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)

    const lines = await h.app.feed.recent(created.id, 50)
    expect(lines.map((l) => l.text)).toContain('Done (0.100s)! For help, type "help"')
    expect(
      lines.every(
        (l) => l.at instanceof Date && ['info', 'warn', 'error', 'chat', 'setup'].includes(l.level),
      ),
    ).toBe(true)
    // The image's own bootstrap is marked as Blockly's work rather than read as the game's.
    expect(lines.filter((l) => l.level === 'setup').map((l) => l.text)).toContain(
      '[init] Starting the Minecraft server...',
    )
    // Newest last, and no more than asked for.
    const times = lines.map((l) => l.at.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(await h.app.feed.recent(created.id, 1)).toHaveLength(1)
  }, 30_000)

  test('a server with no workload has no history', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.app.servers.deleteServer(owner, created.id, created.name)
    await h.settled(created.id)
    await h.db
      .update(schema.serverRuntimes)
      .set({ handle: null })
      .where(eq(schema.serverRuntimes.serverId, created.id))
    expect(await h.app.feed.recent(created.id, 50)).toEqual([])
  }, 30_000)

  test('people opening one console together share one read of its output', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    let reads = 0
    const logs: LogSource = {
      recent: (handle, limit) => {
        reads++
        return h.minecraft.recent(handle, limit)
      },
      tail: (handle, signal) => h.minecraft.tail(handle, signal),
    }
    const feed = new ConsoleFeed(h.db, logs, [...h.runtimes.keys()], { allow: async () => true })

    const [first, second] = await Promise.all([feed.recent(created.id, 50), feed.recent(created.id, 50)])
    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
    expect(await feed.recent(created.id, 50)).toEqual(first)
    expect(reads).toBe(1)
    // A moment later, whoever opens it reads it afresh.
    await Bun.sleep(3 * SECOND_MS)
    await feed.recent(created.id, 50)
    expect(reads).toBe(2)
  }, 30_000)
})
