// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server is updated each time what it should run changes, even back to something it ran before
 * (a key rotation rolled back and made again, a deploy rolled back and deployed again), and it
 * never waits in `updating` with no work queued to move it on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

describe.skipIf(!hasDatabase)('drift that comes back to a spec applied before', () => {
  const ONE = { version: 1, key: 'drift-again-key-one' }
  const TWO = { version: 2, key: 'drift-again-key-two' }
  const ring: { current: typeof ONE; previous: (typeof ONE)[] } = { current: ONE, previous: [] }
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({ runtimeSecrets: ring })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const driftOnce = async (id: string) => {
    const before = await h.server(id)
    expect(await h.app.schedules.drift()).toBe(1)
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1)
    await h.settled(id)
  }

  test('rotate, roll the rotation back, rotate again: the server is updated again, not stuck updating', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Drifted' })
    await h.until(id, 'running')
    await h.settled(id)

    // Rotate to version 2, roll back to version 1, rotate to version 2 again.
    ring.current = TWO
    ring.previous = [ONE]
    await driftOnce(id)
    ring.current = ONE
    ring.previous = [TWO]
    await driftOnce(id)
    ring.current = TWO
    ring.previous = [ONE]
    expect(await h.app.schedules.drift()).toBe(1)
    await Bun.sleep(3 * SECOND_MS)
    await h.settled(id)

    const server = await h.server(id)
    const operations = await h.operations(id)
    const open = operations.filter((op) => op.status === 'queued' || op.status === 'running')
    expect({ status: server.lifecycle.status, openWork: open.length }).toEqual({
      status: 'running',
      openWork: 0,
    })
    expect(operations.filter((op) => op.kind === 'apply' && op.status === 'succeeded')).toHaveLength(3)
  }, 90_000)
})
