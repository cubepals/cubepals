// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What ran slow or failed, kept and read back on a real database: an account's own records and
 * those of work on its servers, groups with how slow they ran and whom they touched, the filters,
 * the sweep, and the database as it is now.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { DiagnosticRecord } from './recorder.ts'
import { DIAGNOSTICS_KEPT_DAYS, DiagnosticsService } from './service.ts'

/** A record of `fields`, a slow query unless they say otherwise. */
const record = (at: Date, fields: Partial<DiagnosticRecord>): DiagnosticRecord => ({
  at,
  kind: 'query',
  name: 'q:aaaaaaaaaaaa',
  ms: 300,
  error: null,
  origin: 'trpc:servers.get',
  role: 'api',
  accountId: null,
  serverId: null,
  requestId: null,
  detail: { statement: 'select $n' },
  ...fields,
})

describe.skipIf(!hasDatabase)('what ran slow or failed', () => {
  let h: Harness
  let service: DiagnosticsService
  let alice: string
  let bob: string
  let alicesServer: string
  const now = new Date()
  const ago = (ms: number) => new Date(now.getTime() - ms)
  beforeAll(async () => {
    h = await startHarness()
    service = new DiagnosticsService(h.db)
    alice = (await h.user('Alice')).userId
    bob = (await h.user('Bob')).userId
    alicesServer = (await h.create({ kind: 'user', userId: alice }, { name: 'Alice’s world' })).id
    await service.write([
      record(ago(3 * MINUTE_MS), { accountId: alice, ms: 400, requestId: 'r1' }),
      record(ago(2 * MINUTE_MS), { accountId: alice, ms: 900, error: '57014' }),
      // A worker's, on her server, with nobody signed in.
      record(ago(MINUTE_MS), {
        serverId: alicesServer,
        origin: 'operation:start',
        role: 'worker',
        name: 'q:bbbbbbbbbbbb',
      }),
      record(ago(MINUTE_MS), {
        accountId: bob,
        kind: 'procedure',
        name: 'servers.list',
        ms: 1500,
        origin: 'trpc:servers.list',
      }),
      record(ago(2 * DAY_MS), { accountId: alice, name: 'q:cccccccccccc' }),
    ])
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('an account’s are its own and those of work on its servers, newest first, with names', async () => {
    const found = await service.list({ accountId: alice }, now)
    expect(found.map((d) => [d.name, d.ms, d.error])).toEqual([
      ['q:bbbbbbbbbbbb', 300, null],
      ['q:aaaaaaaaaaaa', 900, '57014'],
      ['q:aaaaaaaaaaaa', 400, null],
    ])
    expect(found[0]).toMatchObject({
      serverId: alicesServer,
      serverName: 'Alice’s world',
      origin: 'operation:start',
    })
    const [, , first] = found
    expect(first?.accountEmail).toContain('@')
    expect(first?.at).toBe(ago(3 * MINUTE_MS).toISOString())
    expect(first?.requestId).toBe('r1')
  })

  test('narrow by what, how it ended, what it ran under, and when', async () => {
    expect(await service.list({ kind: 'procedure' }, now)).toHaveLength(1)
    expect((await service.list({ failed: 'true' }, now)).map((d) => d.error)).toEqual(['57014'])
    expect(await service.list({ failed: 'false', accountId: alice }, now)).toHaveLength(2)
    expect((await service.list({ origin: 'operation:' }, now)).map((d) => d.role)).toEqual(['worker'])
    // `_` is a letter here, not any one character.
    expect(await service.list({ origin: 'trpc_' }, now)).toHaveLength(0)
    expect(
      await service.list({ since: ago(3 * DAY_MS).toISOString(), name: 'q:cccccccccccc' }, now),
    ).toHaveLength(1)
    expect(
      await service.list({ since: ago(3 * DAY_MS).toISOString(), until: ago(DAY_MS).toISOString() }, now),
    ).toHaveLength(1)
    expect(await service.list({ server: alicesServer }, now)).toHaveLength(1)
  })

  test('group by what they were, with how slow, whom they touched and the slowest of each', async () => {
    const byName = await service.summary({}, now)
    expect(byName).toMatchObject({ by: 'name', total: 4, failed: 1 })
    const queries = byName.groups.find((g) => g.key === 'q:aaaaaaaaaaaa')
    expect(queries).toMatchObject({ count: 2, failed: 1, accounts: 1, maxMs: 900, p50Ms: 650 })
    expect(queries?.slowest.ms).toBe(900)
    expect(byName.groups[0]?.key).toBe('q:aaaaaaaaaaaa')
    expect(byName.thresholds.queryMs).toBeGreaterThan(0)
  })

  test('group by whose, named by email, with nobody’s apart', async () => {
    const byAccount = await service.summary({ by: 'account' }, now)
    expect(byAccount.groups.map((g) => [g.key, g.count])).toEqual([
      [alice, 2],
      [bob, 1],
      ['(none)', 1],
    ])
    expect(byAccount.groups[0]?.label).toContain('@')
    const byServer = await service.summary({ by: 'server', accountId: alice }, now)
    expect(byServer.groups.find((g) => g.key === alicesServer)?.label).toBe('Alice’s world')
  })

  test('the sweep forgets what is past its days', async () => {
    await service.write([record(ago((DIAGNOSTICS_KEPT_DAYS + 1) * DAY_MS), { name: 'q:dddddddddddd' })])
    expect(await service.sweep(now)).toBe(1)
    const left = await h.db
      .select()
      .from(schema.diagnostics)
      .where(eq(schema.diagnostics.name, 'q:dddddddddddd'))
    expect(left).toHaveLength(0)
    expect(await service.list({ since: ago(3 * DAY_MS).toISOString() }, now)).toHaveLength(5)
  })
})

describe.skipIf(!hasDatabase)('the database now', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('says who holds connections, what runs, what took the most time, and the tables', async () => {
    const database = await new DiagnosticsService(h.db).database({ order: 'total', limit: 5 })
    expect(database.max).toBeGreaterThan(0)
    expect(database.connections.reduce((n, c) => n + c.count, 0)).toBeGreaterThan(0)
    expect(Array.isArray(database.active)).toBe(true)
    expect(database.tables.length).toBeGreaterThan(0)
    // Installed only where Postgres loads it at start; either way it says.
    if (database.statements.available) {
      expect(database.statements.top.length).toBeLessThanOrEqual(5)
      for (const statement of database.statements.top) expect(statement.calls).toBeGreaterThan(0)
    } else expect(database.statements.why).toContain('pg_stat_statements')
  })
})
