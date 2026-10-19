// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A join to a server whose start failed for good: told plainly, never that no server is at the
 * address. A start that failed in waking it is tried again by the next join, within the hourly
 * cap; one that failed over what the server runs is its owner's. An edge from before these answers
 * hears what it heard before them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { EDGE_PROTOCOL_BASE } from '@blockly/contracts/edge'
import { NEWER_REASONS } from '@blockly/contracts/edge-poll'
import { schema } from '@blockly/db'
import { createInternalApp, forEdge } from '../../interfaces/edge/internal.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { tuning } from '../tuning.ts'

describe('a failed start, as an edge hears it', () => {
  test('in its own words where it has them, and as before where it has none', () => {
    const failed = { outcome: 'denied', reason: 'failed' } as const
    const broken = { outcome: 'denied', reason: 'broken' } as const
    expect(forEdge(failed, NEWER_REASONS)).toEqual(failed)
    expect(forEdge(broken, NEWER_REASONS)).toEqual(broken)
    expect(forEdge(failed, [])).toEqual({ outcome: 'starting' })
    expect(forEdge(broken, [])).toEqual({ outcome: 'denied', reason: 'suspended' })
    expect(forEdge({ outcome: 'denied', reason: 'quota' }, [])).toEqual({
      outcome: 'denied',
      reason: 'quota',
    })
  })
})

describe.skipIf(!hasDatabase)('a join after a start that failed for good', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const sleeping = async () => {
    const owner = await h.user()
    const { id, slug } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)
    return { owner, id, slug }
  }
  const starts = async (id: string) => (await h.operations(id)).filter((op) => op.kind === 'start').length

  test('over what the server runs is its owner’s: said so, and never started again by a join', async () => {
    const { id, slug } = await sleeping()
    h.runtime.failBootWhen(() => 'the machine would not boot')
    try {
      await h.app.edge.wake(`${slug}.play.test`)
      await h.until(id, 'failed', 30_000)
      await h.settled(id)
      const before = await starts(id)
      expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'denied', reason: 'broken' })
      await h.settled(id)
      expect(await starts(id)).toBe(before)
      expect((await h.server(id)).lifecycle.status).toBe('failed')
    } finally {
      h.runtime.failBootWhen(() => null)
    }
  }, 60_000)

  test('in waking it is tried again, once, by two joins at two edges at once', async () => {
    const { owner, id, slug } = await sleeping()
    // Its host had no room, and no sleep's snapshot holds all its play: failed for good.
    h.runtime.sleeps.fillHost(id)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'failed', 30_000)
    await h.settled(id)
    const before = await starts(id)
    // The host has room again. Neither join is told there's no server at the address.
    const joins = await Promise.all([
      h.app.edge.wake(`${slug}.play.test`),
      h.app.edge.wake(`${slug}.play.test`),
    ])
    for (const join of joins) expect(['ready', 'starting']).toContain(join.outcome)
    await h.until(id, 'running', 30_000)
    await h.settled(id)
    expect(await starts(id)).toBe(before + 1)
  }, 60_000)

  test('an old edge, naming no newer answers, hears a failed wake as still starting', async () => {
    const { owner, id, slug } = await sleeping()
    h.runtime.sleeps.fillHost(id)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'failed', 30_000)
    await h.settled(id)
    h.runtime.sleeps.fillHost(id)
    const edge = createInternalApp({ edge: h.app.edge, token: 'edge-token' })
    const wake = await edge.request(`${EDGE_PROTOCOL_BASE}/wake`, {
      method: 'POST',
      headers: { authorization: 'Bearer edge-token', 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: `${slug}.play.test` }),
    })
    expect(await wake.json()).toEqual({ outcome: 'starting' })
    await h.settled(id)
  }, 60_000)

  test('never counts a start there was no room for, as a waiting join asks again and again', async () => {
    const { id, slug } = await sleeping()
    // On Boat, the plan's starts for the hour are spent: each ask goes back to sleep at once.
    h.runtime.full("the plan's starts for this hour are used up")
    try {
      for (let ask = 0; ask <= tuning().abuse.wakesPerHour; ask++)
        expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'starting' })
      await h.settled(id)
    } finally {
      h.runtime.full(null)
    }
    // Room again: the next join wakes it, its hour's wakes untouched by the asking.
    expect(await h.app.edge.wake(`${slug}.play.test`)).toMatchObject({ outcome: 'ready' })
  }, 120_000)

  test('counts every start a join asked for in the hourly cap, whether it came up or not', async () => {
    const { id, slug } = await sleeping()
    for (let i = 0; i < tuning().abuse.wakesPerHour; i++)
      await h.db.insert(schema.serverOperations).values({
        id: randomUUID(),
        serverId: id,
        kind: 'start',
        status: 'failed',
        input: {},
        requestedBy: 'system:wake',
        idempotencyKey: `start:${randomUUID()}`,
      })
    expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'asleep' })
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
  }, 60_000)
})
