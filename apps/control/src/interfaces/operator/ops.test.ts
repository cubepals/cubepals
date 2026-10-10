/**
 * The accounts and servers operators reach from `scripts/ops.ts`, over services that only record
 * what they were asked: the token is checked before anything, and every call is the operator's.
 * What the services do with it is their own tests' (`app/servers/upkeep-now.test.ts`).
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { AccountDetail } from '../../app/accounts/queries.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { createOpsApi, type OpsApiOptions } from './ops.ts'

const OWNER = '6f1c0b9e-3c1e-4a51-9a39-0a3f2d5b7c11'
const SERVER = '0d2f4e6a-8b1c-4d3e-9f50-a1b2c3d4e5f6'
const ADA = { kind: 'operator', name: 'ada' }

const detail = {
  userId: OWNER,
  name: 'Owner',
  email: 'owner@example.test',
  emailVerified: true,
  createdAt: new Date(0),
  standing: { status: 'active', reason: null, plan: 'free', limitOverrides: {}, restrictions: {} },
  admin: false,
  servers: 0,
  plans: ['free', 'plus'],
  serverList: [],
  history: [],
} as unknown as AccountDetail

/** The API over services that only write down each call they get, in `calls`. */
function recordingApi(calls: Array<[string, ...unknown[]]>) {
  const record =
    (name: string, answer: unknown = undefined) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return answer
    }
  return createOpsApi({
    token: 'operator-token',
    accountQueries: {
      list: record('accounts.list', { total: 1, accounts: [detail] }),
      get: record('accounts.get', detail),
    } as unknown as OpsApiOptions['accountQueries'],
    accounts: {
      setPlan: record('accounts.setPlan'),
      setLimits: record('accounts.setLimits'),
    } as unknown as OpsApiOptions['accounts'],
    servers: {
      createFor: record('servers.createFor', { id: SERVER } as MinecraftServer),
      start: record('servers.start'),
      stop: record('servers.stop'),
      deleteServer: record('servers.deleteServer'),
      undeleteServer: record('servers.undeleteServer'),
    } as unknown as OpsApiOptions['servers'],
    queries: {
      get: record('queries.get', { id: SERVER, status: 'running' }),
    } as unknown as OpsApiOptions['queries'],
    upkeep: {
      rest: record('upkeep.rest'),
      purge: record('upkeep.purge'),
    } as unknown as OpsApiOptions['upkeep'],
  })
}

describe('the operators’ accounts and servers API', () => {
  let calls: Array<[string, ...unknown[]]>
  let api: ReturnType<typeof createOpsApi>

  beforeEach(() => {
    calls = []
    api = recordingApi(calls)
  })

  const call = (method: string, path: string, body?: object, token = 'operator-token') =>
    api.fetch(
      new Request(`http://internal/ops/v1${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'x-operator': 'ada',
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    )
  const named = (name: string) => calls.filter(([called]) => called === name)

  test('refuses a request without the token, or with another, before it reaches anything', async () => {
    for (const token of ['', 'not-the-token', 'operator-token-but-longer']) {
      expect((await call('GET', `/servers/${SERVER}`, undefined, token)).status).toBe(401)
      expect((await call('POST', `/servers/${SERVER}/purge`, { confirmName: 'x' }, token)).status).toBe(401)
    }
    expect(calls).toEqual([])
  })

  test('finds an account by its email, and reads it by its id', async () => {
    const byEmail = await call('GET', '/accounts/Owner@Example.test')
    expect(byEmail.status).toBe(200)
    expect(await byEmail.json()).toMatchObject({ userId: OWNER, plan: 'free', status: 'active' })
    expect(named('accounts.list')[0]).toEqual([
      'accounts.list',
      ADA,
      { search: 'Owner@Example.test', offset: 0, limit: 50 },
    ])
    calls.length = 0
    await call('GET', `/accounts/${OWNER}`)
    expect(calls).toEqual([['accounts.get', ADA, OWNER]])
    expect((await call('GET', '/accounts?search=owner')).status).toBe(200)
  })

  test('an account nobody has is not found', async () => {
    const response = await call('GET', '/accounts/nobody@example.test')
    expect(response.status).toBe(404)
  })

  test('sets an account’s plan and limits as the operator', async () => {
    expect((await call('PUT', `/accounts/${OWNER}/plan`, { plan: 'plus' })).status).toBe(200)
    expect(named('accounts.setPlan')).toEqual([['accounts.setPlan', ADA, OWNER, 'plus']])
    const limits = { maxServers: 3, maxRunning: null, includedUnits: 100 }
    expect((await call('PUT', `/accounts/${OWNER}/limits`, limits)).status).toBe(200)
    expect(named('accounts.setLimits')).toEqual([['accounts.setLimits', ADA, OWNER, limits]])
    expect((await call('PUT', `/accounts/${OWNER}/limits`, { maxServers: 'many' })).status).toBe(400)
  })

  test('makes a server for an owner as the web would: plain survival for five unless told', async () => {
    const response = await call('POST', '/servers', { owner: 'owner@example.test', name: 'Made For You' })
    expect(response.status).toBe(201)
    const [[, actor, ownerId, request]] = named('servers.createFor') as [[string, unknown, string, object]]
    expect(actor).toEqual(ADA)
    expect(ownerId).toBe(OWNER)
    expect(request).toMatchObject({
      name: 'Made For You',
      partySize: '5',
      idempotencyKey: expect.any(String),
    })
    expect((await call('POST', '/servers', { owner: OWNER })).status).toBe(400)
  })

  test('starts, stops, trashes, untrashes, rests and purges a server as the operator', async () => {
    const requestId = '9b2e1c3d-4f5a-4b6c-8d7e-0f1a2b3c4d5e'
    expect((await call('POST', `/servers/${SERVER}/start`, { requestId })).status).toBe(200)
    expect((await call('POST', `/servers/${SERVER}/stop`)).status).toBe(200)
    expect((await call('POST', `/servers/${SERVER}/trash`, { confirmName: 'Made For You' })).status).toBe(200)
    expect((await call('POST', `/servers/${SERVER}/untrash`)).status).toBe(200)
    expect((await call('POST', `/servers/${SERVER}/rest`)).status).toBe(202)
    expect((await call('POST', `/servers/${SERVER}/purge`, { confirmName: 'Made For You' })).status).toBe(202)
    expect(calls.filter(([name]) => name !== 'queries.get')).toEqual([
      ['servers.start', ADA, SERVER, requestId],
      ['servers.stop', ADA, SERVER, expect.any(String)],
      ['servers.deleteServer', ADA, SERVER, 'Made For You'],
      ['servers.undeleteServer', ADA, SERVER],
      ['upkeep.rest', ADA, SERVER, expect.any(String)],
      ['upkeep.purge', ADA, SERVER, 'Made For You'],
    ])
    // Each answers with the server as the operator reads it.
    expect(named('queries.get').every(([, actor]) => JSON.stringify(actor) === JSON.stringify(ADA))).toBe(
      true,
    )
  })

  test('a purge or a trash without the server’s name is refused', async () => {
    expect((await call('POST', `/servers/${SERVER}/purge`)).status).toBe(400)
    expect((await call('POST', `/servers/${SERVER}/trash`, {})).status).toBe(400)
    expect(calls).toEqual([])
  })
})
