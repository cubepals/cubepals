// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which joins a sleeping server wakes for: a player the server has seen on it always wakes it;
 * any other name shares the hour's wakes nobody joined, and past them hears it sleeps; and joins
 * that arrive together share one start.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { NEWER_OUTCOMES } from '@blockly/contracts/edge-poll'
import { schema } from '@blockly/db'
import { forEdge } from '../../interfaces/edge/internal.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { replacePresence, unjoinedWakes } from '../servers/usage.ts'
import { tuning } from '../tuning.ts'

/** `runs` woken runs in the last hour, all over: each joined a moment after it began, or never. */
const woken = async (h: Harness, id: string, runs: number, joined: boolean) => {
  for (let i = 1; i <= runs; i++) {
    const startedAt = new Date(Date.now() - (i * HOUR_MS) / (runs + 2))
    await h.db.insert(schema.powerIntervals).values({
      serverId: id,
      memoryTier: '3g',
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + MINUTE_MS),
      woken: true,
      joinedAt: joined ? new Date(startedAt.getTime() + MINUTE_MS / 2) : null,
    })
  }
}

/** A player the server itself saw on it, under `name`. */
const played = async (h: Harness, id: string, name: string) => {
  const at = new Date(Date.now() - 2 * HOUR_MS)
  await h.db.insert(schema.serverPlayers).values({
    serverId: id,
    playerUuid: randomUUID(),
    playerName: name,
    firstSeenAt: at,
    lastSeenAt: at,
    confirmedAt: at,
  })
}

test('an edge that has no words for a server left asleep hears it still starts', () => {
  expect(forEdge({ outcome: 'asleep' }, NEWER_OUTCOMES)).toEqual({ outcome: 'asleep' })
  expect(forEdge({ outcome: 'asleep' }, [])).toEqual({ outcome: 'starting' })
})

describe.skipIf(!hasDatabase)('wakes a join may start', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const sleeping = async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.app.servers.stop(owner, created.id, randomUUID(), 'idle')
    await h.until(created.id, 'stopped')
    await h.settled(created.id)
    return { id: created.id, slug: created.slug }
  }

  const starts = async (id: string) => (await h.operations(id)).filter((o) => o.kind === 'start').length

  test('an hour of wakes nobody joined never keeps a player who has played there out', async () => {
    const { id, slug } = await sleeping()
    await woken(h, id, tuning().abuse.wakesPerHour, false)
    await played(h, id, 'Alex')
    expect(await h.app.edge.wake(`${slug}.play.test`, true, 'alex')).toMatchObject({ outcome: 'ready' })
    expect((await h.server(id)).lifecycle.status).toBe('running')
    await h.settled(id)
  }, 30_000)

  test('past the hour’s wakes nobody joined, any other name hears it sleeps, and nothing starts', async () => {
    const { id, slug } = await sleeping()
    await woken(h, id, tuning().abuse.wakesPerHour, false)
    // Seen only at the door, never by the server itself: not someone who has played there.
    await h.db.insert(schema.serverPlayers).values({
      serverId: id,
      playerUuid: randomUUID(),
      playerName: 'Steve',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    })
    const before = await starts(id)
    for (const name of ['Steve', 'Herobrine', undefined])
      expect(await h.app.edge.wake(`${slug}.play.test`, true, name)).toEqual({ outcome: 'asleep' })
    expect(await starts(id)).toBe(before)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
  }, 30_000)

  test('starts a join asked for count toward the hour until a player joins the run they woke', async () => {
    const { id, slug } = await sleeping()
    const wakes = tuning().abuse.wakesPerHour
    for (let i = 0; i < wakes; i++)
      await h.db.insert(schema.serverOperations).values({
        id: randomUUID(),
        serverId: id,
        kind: 'start',
        status: 'succeeded',
        input: {},
        requestedBy: 'system:wake',
        idempotencyKey: `start:${randomUUID()}`,
      })
    expect(await h.app.edge.wake(`${slug}.play.test`, true, 'Newcomer')).toEqual({ outcome: 'asleep' })
    // One of those runs was joined: a wake is free again.
    await woken(h, id, 1, true)
    expect(await h.app.edge.wake(`${slug}.play.test`, true, 'Newcomer')).toMatchObject({ outcome: 'ready' })
    await h.settled(id)
  }, 30_000)

  test('wakes a player joined use none of the hour', async () => {
    const { id, slug } = await sleeping()
    await woken(h, id, tuning().abuse.wakesPerHour * 2, true)
    expect(await h.app.edge.wake(`${slug}.play.test`, true, 'Newcomer')).toMatchObject({ outcome: 'ready' })
    await h.settled(id)
  }, 30_000)

  test('a run is joined once the server itself sees a player on it', async () => {
    const { id, slug } = await sleeping()
    expect(await h.app.edge.wake(`${slug}.play.test`, true, 'Alex')).toMatchObject({ outcome: 'ready' })
    await h.settled(id)
    expect(await unjoinedWakes(h.db, id, new Date())).toBe(1)
    await replacePresence(h.db, id, [{ uuid: randomUUID(), name: 'Alex' }], new Date())
    expect(await unjoinedWakes(h.db, id, new Date())).toBe(0)
  }, 30_000)

  test('joins that arrive together start the server once', async () => {
    const { id, slug } = await sleeping()
    const asked = spyOn(h.app.servers, 'start')
    try {
      const names = ['Alex', 'Steve', 'Herobrine', undefined, 'Notch']
      const results = await Promise.all(names.map((name) => h.app.edge.wake(`${slug}.play.test`, true, name)))
      for (const result of results) expect(result).toMatchObject({ outcome: 'ready' })
      expect(asked).toHaveBeenCalledTimes(1)
    } finally {
      asked.mockRestore()
    }
    await h.settled(id)
  }, 30_000)

  test('a player who has played there starts it even while another name’s wake was left asleep', async () => {
    const { id, slug } = await sleeping()
    await woken(h, id, tuning().abuse.wakesPerHour, false)
    await played(h, id, 'Alex')
    const [stranger, player] = await Promise.all([
      h.app.edge.wake(`${slug}.play.test`, true, 'Herobrine'),
      h.app.edge.wake(`${slug}.play.test`, true, 'Alex'),
    ])
    // The stranger's wake starts nothing; it may share the player's start, if that came first.
    expect(['asleep', 'ready']).toContain(stranger.outcome)
    expect(player).toMatchObject({ outcome: 'ready' })
    await h.settled(id)
  }, 30_000)
})
