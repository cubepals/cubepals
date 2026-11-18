// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A change to what a server boots, saved while it is failed: how a failure's fix is tried. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import type { ServerSettings } from '../../domain/revision/revision.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'

describe.skipIf(!hasDatabase)('a change on a failed server', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    h.runtime.failBootWhen(() => null)
    await h.close()
  })

  const running = async () => {
    const owner = await h.user()
    const server = await h.create(owner, { name: 'Failed server' })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  const property = async (id: string, key: string) =>
    new RegExp(`^${key}=(.*)$`, 'm').exec((await h.minecraft.file(id, 'server.properties')) ?? '')?.[1]
  const change = async (owner: UserActor, id: string, patch: Partial<ServerSettings>) => {
    const current = (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings
    return h.app.revisions.changeSettings(owner, id, { ...current, ...patch }, randomUUID())
  }

  test('a change saved on a server that failed to start starts it with the change', async () => {
    const { owner, id } = await running()
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    h.runtime.failBootWhen(() => 'the world was saved by a newer Minecraft')
    await h.app.servers.start(owner, id, randomUUID())
    const failed = await h.until(id, 'failed', 30_000)
    expect(failed.lifecycle.failure?.during).toBe('starting')
    h.runtime.failBootWhen(() => null)
    // Starts spend, so the change is refused where a start would be.
    await h.db.update(schema.platformControls).set({ startsEnabled: false })
    try {
      const refused = await change(owner, id, { spawnProtection: 6 }).then(
        () => null,
        (error: { code?: string }) => error.code,
      )
      expect(refused).toBe('platform_paused')
    } finally {
      await h.db.update(schema.platformControls).set({ startsEnabled: true })
    }
    await change(owner, id, { spawnProtection: 6 })
    await h.until(id, 'running', 30_000)
    expect(await property(id, 'spawn-protection')).toBe('6')
  }, 60_000)
})
