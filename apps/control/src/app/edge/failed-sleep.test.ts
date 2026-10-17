// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A sleep whose stop fails for good is forced off and the server recorded failed `during:
 * 'stopping'`, with the owner told it was on Cubepals' side. That failure is Blockly's, not the
 * owner's: its compute is off, and a join wakes it as it would any sleeping server.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

describe.skipIf(!hasDatabase)('a join wakes a server whose sleep failed', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a join after an idle stop that failed wakes the server', async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    h.runtime.failStops('the provider timed out stopping the machine')
    try {
      await h.app.servers.stop({ kind: 'system', reason: 'idle' }, id, randomUUID(), 'idle')
      const failed = await h.until(id, 'failed', 20_000)
      expect(failed.lifecycle.failure).toMatchObject({ during: 'stopping' })
      expect(failed.lifecycle.failure?.message).toContain('Cubepals’ side')
    } finally {
      h.runtime.failStops(null)
    }
    await h.settled(id)
    // Forced off: nothing runs, nothing is billed.
    expect(h.runtime.machine(id)?.state).toBe('stopped')

    // Woken, as any sleeping server is.
    expect((await h.app.edge.wake(`${slug}.play.test`)).outcome).toBe('ready')
  }, 60_000)
})
