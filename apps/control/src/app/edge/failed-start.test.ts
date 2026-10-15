// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A join to a server whose start failed for good: told plainly to try again, and its next try
 * starts the server again, rather than being told no server is at the address.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

describe.skipIf(!hasDatabase)('a join after a start that failed for good', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('is said plainly, and the next join tries it again', async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)

    h.runtime.failBootWhen(() => 'the machine would not boot')
    try {
      await h.app.edge.wake(`${slug}.play.test`)
      await h.until(id, 'failed', 30_000)
      await h.settled(id)
      // Never "no server at this address": a join is told to try again, and its try starts it.
      expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'denied', reason: 'failed' })
      await h.settled(id)
    } finally {
      h.runtime.failBootWhen(() => null)
    }
    expect(await h.app.edge.wake(`${slug}.play.test`)).toMatchObject({ outcome: 'ready' })
    expect((await h.server(id)).lifecycle.status).toBe('running')
  }, 60_000)
})
