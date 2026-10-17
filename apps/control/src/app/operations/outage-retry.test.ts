// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operation's last attempt records its failure and completes its job even when settling it
 * (`abandon`) fails too, as the forced stop after a failed stop does while the provider is down.
 * The server's queue keeps moving, and the owner's "Try again" runs once the provider is back.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { SECOND_MS } from '@blockly/contracts/durations'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

describe.skipIf(!hasDatabase)('an operation that cannot be settled after it fails', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a stop that failed while the provider was down can be tried again once it is back', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Outage' })
    await h.until(id, 'running')
    await h.settled(id)

    // The provider is down: stops fail, and so does the forced stop that abandoning one makes.
    h.runtime.failStops('the provider is down')
    const forced = spyOn(h.runtime, 'forceStop').mockRejectedValue(new Error('the provider is down'))
    try {
      await h.app.servers.stop(owner, id, randomUUID())
      const failed = await h.until(id, 'failed', 20_000)
      expect(failed.lifecycle.failure?.during).toBe('stopping')
    } finally {
      h.runtime.failStops(null)
      forced.mockRestore()
    }
    await Bun.sleep(2 * SECOND_MS)
    expect((await h.jobs.blockedOperations()).filter((b) => b.serverId === id)).toEqual([])
    const stop = (await h.operations(id)).find((op) => op.kind === 'stop' && op.status === 'failed')
    expect(stop?.detail).toContain('settling it failed too: the provider is down')

    // The provider is back. The owner tries again.
    await h.app.servers.retry(owner, id, randomUUID())
    const after = await h
      .until(id, (s) => s.lifecycle.status === 'stopped', 15_000)
      .catch(async () => h.server(id))
    expect(after.lifecycle.status).toBe('stopped')
  }, 60_000)
})
