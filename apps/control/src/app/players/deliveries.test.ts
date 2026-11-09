// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Delivering what waits for a player on a control plane whose pool holds one connection, as
 * DATABASE_POOL_MAX may set it: a delivery keeps the connection it holds its hold on, and takes no
 * other, so it finishes rather than waiting on itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness({ poolMax: 1 })
}, 30_000)

afterAll(async () => {
  await h?.close()
})

describe.skipIf(!hasDatabase)('with one connection', () => {
  test('what waits is delivered as they join', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const kai = { uuid: randomUUID(), name: 'Kai' }
    await h.app.players
      .act(owner, id, kai.uuid, { kind: 'give', item: 'diamond', count: 2 })
      .catch(() => undefined)
    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    await h.app.players.act(owner, id, kai.uuid, { kind: 'levels', levels: 1 })
    expect(h.minecraft.heard(id)).toContain('experience add Kai 1 levels')
  }, 30_000)
})
