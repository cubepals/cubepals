// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shapes joins are reported in and the `SIGNALS` setting (`@blockly/contracts/join-records`),
 * and the tables they are kept in.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { ServerJoinBatch, SignalsConfig, VisitBatch } from '@blockly/contracts/join-records'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

describe('the SIGNALS setting', () => {
  test('an empty setting turns nothing on', () => {
    expect(SignalsConfig.parse({})).toEqual({})
  })

  test('takes every kind with its own figures', () => {
    const config = {
      watchedAddresses: ['somewhere'],
      ourServers: 'official' as const,
      slowJoin: { loginToWorldS: 7, connectToWorldS: { memory: 3, stopped: 20, atRest: 90 } },
      leftWhileLoading: {},
      shortStay: { underS: 4 },
      lookNoJoin: { watchedEveryOne: true, digestMinutes: 15 },
      legacyLoginListener: { oursOnly: false },
    }
    expect(SignalsConfig.parse(config)).toEqual(config)
  })

  test('refuses a limit that is not positive', () => {
    expect(SignalsConfig.safeParse({ shortStay: { underS: 0 } }).success).toBe(false)
    expect(SignalsConfig.safeParse({ crowd: { playersIn10Min: -1 } }).success).toBe(false)
  })
})

describe('the reports', () => {
  const report = {
    joinId: '01900000-0000-7000-8000-000000000001',
    phase: 'open',
    edgeId: 'edge-1',
    region: 'fra',
    address: 'friends.play.example',
    source: '203.0.113.9:51234',
    connectedAt: '2026-10-20T10:00:00.000Z',
  }

  test('a visit needs only who, where and when', () => {
    expect(VisitBatch.safeParse({ reports: [report] }).success).toBe(true)
    expect(VisitBatch.safeParse({ reports: [{ ...report, phase: 'later' }] }).success).toBe(false)
  })

  test('a batch carries at most 200', () => {
    expect(VisitBatch.safeParse({ reports: Array(201).fill(report) }).success).toBe(false)
    const event = { kind: 'login', at: '2026-10-20T10:00:01.123456789Z', uuid: 'x', name: 'Steve' }
    expect(ServerJoinBatch.safeParse({ events: Array(200).fill(event) }).success).toBe(true)
    expect(ServerJoinBatch.safeParse({ events: Array(201).fill(event) }).success).toBe(false)
  })
})

describe.skipIf(!hasDatabase)('the tables', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a join starts with nothing from the server, and a signal is raised once per key', async () => {
    const owner = await h.user()
    const server = await h.create(owner, { name: 'Tables' })
    const id = randomUUID()
    await h.db.insert(schema.joins).values({
      id,
      kind: 'join',
      serverId: server.id,
      address: 'tables.play.test',
      connectedAt: new Date(),
    })
    const [row] = await h.db.select().from(schema.joins).where(eq(schema.joins.id, id))
    expect(row?.serverSide).toBe('not_reported')
    expect(row?.detail).toEqual({})

    const signal = { kind: 'slow_join', key: `slow_join:${id}:login`, at: new Date(), joinId: id }
    await h.db.insert(schema.signals).values(signal).onConflictDoNothing()
    await h.db.insert(schema.signals).values(signal).onConflictDoNothing()
    const raised = await h.db.select().from(schema.signals).where(eq(schema.signals.joinId, id))
    expect(raised.length).toBe(1)
    expect(raised[0]?.closedAt).toBeNull()
  })
})
