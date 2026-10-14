// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An update that didn't start, whose way back the runtime refused, as Fly refused one while it
 * still put the update before in place (staging, 2026-10-14): the server rests stopped on what it
 * ran, not failed, and starts on it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision, loadRuntime } from '../servers/persistence.ts'

describe.skipIf(!hasDatabase)('going back refused', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterEach(() => {
    h.runtime.failBootWhen(() => null)
  })

  afterAll(async () => {
    await h.close()
  })

  test('the server rests stopped on what it ran, not failed, and its next start runs that', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Way back' })
    await h.until(id, 'running')
    await h.settled(id)
    const before = await h.server(id)
    const settings = (await loadRevision(h.db, before.desiredRevisionId)).settings
    h.runtime.failBootWhen((spec) =>
      spec.env.SPAWN_PROTECTION === '4' ? 'the server refused to start' : null,
    )
    // Going back is refused, as Fly refused an update while it still put the one before in place.
    const original = h.runtime.apply
    h.runtime.apply = async (handle, spec) => {
      if (spec.env.SPAWN_PROTECTION !== '4') throw new Error('the provider refused the update')
      return original.call(h.runtime, handle, spec)
    }
    try {
      await h.app.revisions.changeSettings(owner, id, { ...settings, spawnProtection: 4 }, randomUUID())
      const stopped = await h.until(id, 'stopped', 30_000)
      expect(stopped.lifecycle.failure).toBeNull()
    } finally {
      h.runtime.apply = original
    }
    await h.settled(id)
    const update = (await h.operations(id)).filter((op) => op.kind === 'apply').at(-1)
    expect(update?.status).toBe('failed')
    expect(update?.error).toContain('Nothing changed')
    expect(h.runtime.machine(id)?.state).not.toBe('running')
    expect((await h.server(id)).desiredRevisionId).toBe(before.desiredRevisionId)
    expect((await loadRuntime(h.db, id, ['fake'])).applied?.revisionId).toBe(before.desiredRevisionId)
    // Its next start puts what it ran back on its machine.
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    const properties = (await h.minecraft.file(id, 'server.properties')) ?? ''
    expect(/^spawn-protection=(.*)$/m.exec(properties)?.[1]).toBe('0')
  }, 40_000)
})
