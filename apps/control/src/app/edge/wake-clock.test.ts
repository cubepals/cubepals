// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A wake names the start it asked for (`wakeOperationId`) by the database's clock, which writes the
 * start, not the control plane's own: a control plane whose clock runs ahead still finds it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { databaseNow, wakeStarts } from '../operations/persistence.ts'

describe.skipIf(!hasDatabase)('a wake on a clock ahead of the database’s', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  afterEach(() => {
    setSystemTime()
  })

  test('still names the start it asked for', async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)

    setSystemTime(new Date(Date.now() + MINUTE_MS))
    const began = await databaseNow(h.db)
    const woken = await h.app.edge.wake(`${slug}.play.test`)
    await h.settled(id)
    const [start] = (await h.operations(id)).filter((o) => o.kind === 'start')
    expect(woken).toMatchObject({ outcome: 'ready', wakeOperationId: start?.id })
    // Once the start is over, only the database's clock still finds it; this one's runs ahead.
    expect((await wakeStarts(h.db, id, began)).map((o) => o.id)).toEqual([start?.id ?? ''])
    expect(await wakeStarts(h.db, id, new Date())).toEqual([])
  }, 30_000)
})
