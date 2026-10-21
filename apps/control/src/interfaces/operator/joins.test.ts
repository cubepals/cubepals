// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Joins and signals through the operators' API over the real control plane (`joins.ts`): joins
 * narrowed and newest first, one with its wake's start and its signals, the one nearest a moment,
 * the open signals and those closed since, and a signal closed by the operator who named
 * themselves. A join's client address is never in what it answers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HOUR_MS } from '@blockly/contracts/durations'
import type { JoinDetailView, JoinView, SignalView } from '@blockly/contracts/join-records'
import { schema } from '@blockly/db'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { OPS_BASE } from './gate.ts'
import { createOpsApi, type OpsApiOptions } from './ops.ts'

const TOKEN = 'operator-token'
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS)
const STEVE = '8667ba71-b85a-4004-af54-457a9734eed7'

describe.skipIf(!hasDatabase)('joins and signals through the operators’ API', () => {
  let h: Harness
  let api: ReturnType<typeof createOpsApi>
  let serverId: string
  let slug: string
  const ids = { first: randomUUID(), second: randomUUID(), other: randomUUID(), wake: randomUUID() }

  const call = async (method: 'GET' | 'POST', path: string) => {
    const response = await api.fetch(
      new Request(`http://internal${OPS_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-operator': 'ada',
          'content-type': 'application/json',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }),
    )
    return { status: response.status, body: (await response.json()) as unknown }
  }

  beforeAll(async () => {
    h = await startHarness()
    api = createOpsApi({ ...h.app, upkeep: h.app.servers.upkeep, token: TOKEN } as unknown as OpsApiOptions)
    const made = await h.create(await h.user(), { name: 'Castle' })
    serverId = made.id
    slug = made.slug
    await h.db.insert(schema.serverOperations).values({
      id: ids.wake,
      serverId,
      kind: 'start',
      status: 'succeeded',
      requestedBy: 'system:wake',
      idempotencyKey: 'test-join-wake',
      steps: [{ step: 'booting', at: '2026-10-20T09:00:05.000Z' }],
    })
    const join = (id: string, at: Date, fields: Partial<typeof schema.joins.$inferInsert> = {}) => ({
      id,
      kind: 'join' as const,
      serverId,
      address: `${slug}.play.test`,
      connectedAt: at,
      playerName: 'Steve',
      playerUuid: STEVE,
      source: '203.0.113.9:5000',
      ...fields,
    })
    await h.db.insert(schema.joins).values([
      join(ids.first, hoursAgo(3), { wakeOperationId: ids.wake }),
      join(ids.second, hoursAgo(1)),
      join(ids.other, hoursAgo(2), {
        playerName: 'Alex',
        playerUuid: null,
        address: 'sunset-valley.play.test',
      }),
    ])
    await h.db.insert(schema.signals).values([
      {
        kind: 'slow_join',
        key: `slow_join:${ids.first}:login`,
        joinId: ids.first,
        serverId,
        at: hoursAgo(2.9),
      },
      {
        kind: 'crowd',
        key: 'crowd:closed',
        serverId,
        at: hoursAgo(5),
        closedAt: hoursAgo(4.5),
        closedBy: 'operator:bo',
      },
    ])
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('lists joins newest first, narrowed by server, player and address, without client addresses', async () => {
    const all = (await call('GET', `/joins?server=${slug}`)).body as { joins: JoinView[] }
    expect(all.joins.map((j) => j.id)).toEqual([ids.second, ids.other, ids.first])
    expect(JSON.stringify(all)).not.toContain('203.0.113.9')
    const steve = (await call('GET', `/joins?player=steve&since=${hoursAgo(1.5).toISOString()}`)).body as {
      joins: JoinView[]
    }
    expect(steve.joins.map((j) => j.id)).toEqual([ids.second])
    const kept = (await call('GET', '/joins?address=sunset-valley')).body as { joins: JoinView[] }
    expect(kept.joins.map((j) => j.id)).toEqual([ids.other])
  })

  test('one join with its wake’s steps, its signals and how often its player came', async () => {
    const view = (await call('GET', `/joins/${ids.first}`)).body as JoinDetailView
    expect(view.join).toMatchObject({ id: ids.first, serverName: 'Castle', playerName: 'Steve' })
    expect(view.wake).toMatchObject({ id: ids.wake, kind: 'start', steps: [{ step: 'booting' }] })
    expect(view.signals.map((s) => s.kind)).toEqual(['slow_join'])
    expect(view.joinsOnServer).toBe(2)
    expect((await call('GET', `/joins/${randomUUID()}`)).status).toBe(404)
  })

  test('the join nearest a moment, or the latest', async () => {
    const nearest = (await call('GET', `/joins/find?player=${STEVE}&at=${hoursAgo(2.8).toISOString()}`))
      .body as JoinDetailView
    expect(nearest.join.id).toBe(ids.first)
    const latest = (await call('GET', '/joins/find?player=Steve')).body as JoinDetailView
    expect(latest.join.id).toBe(ids.second)
    // A join only the server reported has a random (version 4) id, as a player does.
    expect(ids.first[14]).toBe('4')
    const byId = (await call('GET', `/joins/find?player=${ids.first}`)).body as JoinDetailView
    expect(byId.join.id).toBe(ids.first)
  })

  test('open signals oldest first, closed ones since a moment, and one closed by its operator', async () => {
    const open = (await call('GET', '/signals')).body as { signals: SignalView[] }
    expect(open.signals.map((s) => s.kind)).toEqual(['slow_join'])
    const since = (await call('GET', `/signals?since=${hoursAgo(6).toISOString()}`)).body as {
      signals: SignalView[]
    }
    expect(since.signals.map((s) => s.kind)).toEqual(['crowd', 'slow_join'])
    const id = open.signals[0]?.id
    const closed = (await call('POST', `/signals/${id}/close`)).body as SignalView
    expect(closed.closedBy).toBe('operator:ada')
    expect(((await call('GET', '/signals')).body as { signals: SignalView[] }).signals).toEqual([])
    expect((await call('POST', `/signals/${id}/close`)).status).toBe(404)
  })
})
