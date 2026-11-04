// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One account's trouble through the operators' API, on the whole control plane and a real
 * database: its server's operations, a join that never reached the world behind many that did, and
 * a slow query it ran, found by its email; and the platform's records grouped by whom they touched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type {
  AccountDiagnosisView,
  DatabaseView,
  DiagnosticsSummaryView,
} from '@blockly/contracts/diagnostics'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { PlatformHealth } from '../../app/platform/health.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { operatorApis } from './mount.ts'

describe.skipIf(!hasDatabase)('an account’s trouble, asked of the operators’ API', () => {
  let h: Harness
  let call: (path: string) => Promise<Response>
  let email: string
  let userId: string
  let serverId: string

  beforeAll(async () => {
    h = await startHarness()
    const actor = await h.user('Troubled')
    userId = actor.userId
    serverId = (await h.create(actor, { name: 'Troubled world' })).id
    await h.settled(serverId)
    const [user] = await h.db.select().from(schema.users).where(eq(schema.users.id, userId))
    email = user?.email ?? ''
    const now = Date.now()
    await h.db.insert(schema.joins).values({
      id: randomUUID(),
      kind: 'join',
      serverId,
      address: 'troubled.play.test',
      connectedAt: new Date(now - 5 * MINUTE_MS),
      leftAt: new Date(now - 4 * MINUTE_MS),
      leftReason: 'gave_up_waiting',
      playerName: 'Steve',
    })
    // A busy server: more joins that reached the world since than a diagnosis lists.
    await h.db.insert(schema.joins).values(
      Array.from({ length: 120 }, (_, i) => ({
        id: randomUUID(),
        kind: 'join' as const,
        serverId,
        address: 'troubled.play.test',
        connectedAt: new Date(now - 3 * MINUTE_MS + i * 1000),
        inWorldAt: new Date(now - 3 * MINUTE_MS + i * 1000 + 500),
        playerName: `Friend${i}`,
      })),
    )
    await h.app.diagnostics.write([
      {
        at: new Date(now - MINUTE_MS),
        kind: 'query',
        name: 'q:0a1b2c3d4e5f',
        ms: 812,
        error: null,
        origin: 'trpc:servers.get',
        role: 'api',
        accountId: userId,
        serverId,
        requestId: 'req-1',
        detail: { operation: 'SELECT', statement: 'select * from "minecraft_servers" where "id" = $n' },
      },
    ])
    const api = { health: new PlatformHealth({ db: h.db }), flySuspend: {}, moderation: {} }
    const apis = operatorApis(h.app, api as unknown as Parameters<typeof operatorApis>[1], 'operator-token')
    call = async (path) =>
      apis.fetch(
        new Request(`http://internal/ops/v1${path}`, {
          headers: { authorization: 'Bearer operator-token', 'x-operator': 'ada' },
        }),
      )
  }, 60_000)

  afterAll(async () => {
    await h.close()
  })

  test('by its email: its server, the work done on it, the join that stopped and the slow query', async () => {
    const response = await call(`/accounts/${encodeURIComponent(email)}/diagnosis`)
    expect(response.status).toBe(200)
    const diagnosis = (await response.json()) as AccountDiagnosisView
    expect(diagnosis.account).toMatchObject({ id: userId, email })
    expect(diagnosis.servers.map((s) => s.id)).toEqual([serverId])
    expect(diagnosis.operations.slowest.map((op) => op.serverId)).toContain(serverId)
    expect(diagnosis.operations.failed).toEqual([])
    expect(diagnosis.joins.map((j) => j.leftReason)).toEqual(['gave_up_waiting'])
    expect(diagnosis.diagnostics.summary.map((g) => [g.key, g.count, g.maxMs])).toEqual([
      ['q:0a1b2c3d4e5f', 1, 812],
    ])
    expect(diagnosis.diagnostics.recent[0]).toMatchObject({
      accountEmail: email,
      serverName: 'Troubled world',
    })
  })

  test('the platform’s records grouped by whom they touched, and the database now', async () => {
    const summary = (await (await call('/diagnostics/summary?by=account')).json()) as DiagnosticsSummaryView
    expect(summary.groups.map((g) => [g.key, g.label])).toEqual([[userId, email]])
    const operations = (await (await call(`/operations?server=${serverId}`)).json()) as {
      operations: unknown[]
    }
    expect(operations.operations.length).toBeGreaterThan(0)
    const database = (await (await call('/database')).json()) as DatabaseView
    expect(database.max).toBeGreaterThan(0)
  })
})
