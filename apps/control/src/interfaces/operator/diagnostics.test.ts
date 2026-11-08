// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The operators' diagnostics routes over services that write down each call: an account found by
 * its email, groupings refused when unknown, the database read as asked, one account's trouble
 * put together, and the token wanted.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { AccountDiagnosisView } from '@blockly/contracts/diagnostics'
import type { JoinView, SignalView } from '@blockly/contracts/join-records'
import { Hono } from 'hono'
import type { AccountDetail } from '../../app/accounts/queries.ts'
import { NotFound } from '../../app/errors.ts'
import { type DiagnosticsOptions, diagnosticsRoutes } from './diagnostics.ts'
import { gate } from './gate.ts'

const OWNER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SERVER = '3b1f5c2a-7d4e-4f6a-9b8c-1d2e3f4a5b6c'
const OTHER = '9a1f5c2a-7d4e-4f6a-9b8c-1d2e3f4a5b6c'
const account = {
  userId: OWNER,
  name: 'Owner',
  email: 'owner@example.test',
  standing: { status: 'active', plan: 'plus', testAccount: false },
  serverList: [{ id: SERVER, name: 'World', slug: 'world', status: 'running', deleted: false }],
  notice: null,
} as unknown as AccountDetail

const join = (fields: Partial<JoinView>) =>
  ({ id: fields.connectedAt, kind: 'join', inWorldAt: null, leftReason: null, ...fields }) as JoinView
const signal = (serverId: string) => ({ id: 1, kind: 'slow_join', serverId }) as SignalView

let calls: Array<[string, unknown]>
let app: Hono

beforeEach(() => {
  calls = []
  const record =
    (name: string, answer: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, args[0]])
      return answer
    }
  const options: DiagnosticsOptions = {
    diagnostics: {
      list: record('list', [{ id: 1 }]),
      summary: record('summary', { groups: [{ key: 'q:aaaaaaaaaaaa' }] }),
      database: record('database', { max: 100 }),
    } as unknown as DiagnosticsOptions['diagnostics'],
    health: {
      ofServers: record('ofServers', { failed: [], slowest: [] }),
    } as unknown as DiagnosticsOptions['health'],
    vitals: {
      worst: record('vitals', { since: '', servers: [{ serverId: SERVER, laggingMinutes: 3 }] }),
    } as unknown as DiagnosticsOptions['vitals'],
    joins: {
      // As the joins list answers when asked only for those that stopped short.
      list: record('joins', [
        join({ connectedAt: '2026-11-04T11:00:00.000Z', leftReason: 'gave_up_waiting' }),
        join({
          connectedAt: '2026-11-04T12:00:00.000Z',
          inWorldAt: '2026-11-04T12:00:05.000Z',
          leftReason: 'refused:whitelist',
        }),
      ]),
      signals: record('signals', [signal(SERVER), signal(OTHER)]),
    } as unknown as DiagnosticsOptions['joins'],
  }
  app = new Hono()
  gate(app, '/ops/v1', 'token')
  diagnosticsRoutes(app, options, async (_operator, ref) => {
    if (ref === OWNER || ref === account.email) return account
    throw new NotFound('Account')
  })
})

const get = (path: string) =>
  app.request(path, { headers: { authorization: 'Bearer token', 'x-operator': 'ada' } })

describe('the operators’ diagnostics', () => {
  test('find an account’s records by its email, as its id', async () => {
    const response = await get(
      '/ops/v1/diagnostics?account=owner@example.test&kind=query&failed=true&limit=5',
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ diagnostics: [{ id: 1 }] })
    expect(calls).toEqual([['list', { accountId: OWNER, kind: 'query', failed: 'true', limit: 5 }]])
  })

  test('group them as asked, and refuse what isn’t a grouping or an account', async () => {
    expect((await get('/ops/v1/diagnostics/summary?by=account&origin=trpc:')).status).toBe(200)
    expect(calls).toEqual([['summary', { by: 'account', origin: 'trpc:' }]])
    expect((await get('/ops/v1/diagnostics/summary?by=everything')).status).toBe(400)
    expect((await get('/ops/v1/diagnostics?account=nobody@example.test')).status).toBe(404)
    expect((await get('/ops/v1/diagnostics')).status).toBe(200)
  })

  test('read the database now, in the order asked', async () => {
    expect(await (await get('/ops/v1/database?order=mean&limit=3')).json()).toEqual({ max: 100 })
    expect(calls).toEqual([['database', { order: 'mean', limit: 3 }]])
  })

  test('put an account’s trouble together: its joins that stopped short and its own servers’ signals', async () => {
    const response = await get(`/ops/v1/accounts/${OWNER}/diagnosis?since=2026-11-03T00:00:00Z`)
    expect(response.status).toBe(200)
    const diagnosis = (await response.json()) as AccountDiagnosisView
    expect(diagnosis.account).toEqual({
      id: OWNER,
      email: 'owner@example.test',
      name: 'Owner',
      plan: 'plus',
      status: 'active',
      test: false,
    })
    expect(diagnosis.since).toBe('2026-11-03T00:00:00.000Z')
    expect(diagnosis.joins.map((j) => j.connectedAt)).toEqual([
      '2026-11-04T12:00:00.000Z',
      '2026-11-04T11:00:00.000Z',
    ])
    expect(diagnosis.signals.map((s) => s.serverId)).toEqual([SERVER])
    expect(diagnosis.vitals.map((v) => [v.serverId, v.laggingMinutes])).toEqual([[SERVER, 3]])
    expect(diagnosis.diagnostics.summary.map((g) => g.key)).toEqual(['q:aaaaaaaaaaaa'])
    expect(diagnosis.elsewhere.join(' ')).toContain(OWNER)
    expect(calls.find(([name]) => name === 'summary')?.[1]).toMatchObject({ accountId: OWNER, by: 'name' })
    // Only joins that stopped short are asked for, so a busy server's good joins never crowd them out.
    expect(calls.find(([name]) => name === 'joins')?.[1]).toMatchObject({
      server: SERVER,
      stoppedShort: true,
    })
    expect(calls.find(([name]) => name === 'ofServers')?.[1]).toMatchObject({ kind: 'operator', name: 'ada' })
  })

  test('want the operator’s token', async () => {
    expect((await app.request('/ops/v1/database')).status).toBe(401)
  })
})
