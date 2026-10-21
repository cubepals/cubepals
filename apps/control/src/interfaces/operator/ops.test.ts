// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The accounts, servers and platform operators reach from `scripts/ops.ts`, over services that only
 * record what they were asked: the token is checked before anything, and every call is the
 * operator's. What the services do with it is their own tests' (`app/servers/upkeep-now.test.ts`).
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { SERVER_ICONS } from '@blockly/contracts'
import type { AccountDetail } from '../../app/accounts/queries.ts'
import type { ControlPlane } from '../../app/control-plane.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { operatorApis } from './mount.ts'
import { createOpsApi, type OpsApiOptions } from './ops.ts'

const OWNER = '6f1c0b9e-3c1e-4a51-9a39-0a3f2d5b7c11'
const SERVER = '0d2f4e6a-8b1c-4d3e-9f50-a1b2c3d4e5f6'
const ADA = { kind: 'operator', name: 'ada' }
const PLAYER = '3b1f5c2a-7d4e-4f6a-9b8c-1d2e3f4a5b6c'
const JAR = 'a'.repeat(128)
const SETTINGS = {
  difficulty: 'normal',
  defaultGameMode: 'survival',
  pvp: true,
  viewDistance: 8,
  simulationDistance: 6,
  maxPlayers: 5,
  motd: 'A server created by Cubepals',
  spawnProtection: 0,
  onlineMode: true,
}
const CONTROLS = {
  provisioningEnabled: true,
  startsEnabled: true,
  publicListingEnabled: true,
  uploadsEnabled: true,
  storingEnabled: true,
  expiringEnabled: true,
  maxServers: 100,
  maxRunningServers: 50,
  maxFreeAccounts: 1000,
  dailySpendLimitCents: 0,
}

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
    joins: {
      list: record('joins.list', []),
      detail: record('joins.detail', {}),
      find: record('joins.find', {}),
      signals: record('signals.list', []),
      closeSignal: record('signals.close', {}),
    } as unknown as OpsApiOptions['joins'],
    accountQueries: {
      list: record('accounts.list', { total: 1, accounts: [detail] }),
      get: record('accounts.get', detail),
    } as unknown as OpsApiOptions['accountQueries'],
    accounts: {
      setPlan: record('accounts.setPlan'),
      setLimits: record('accounts.setLimits'),
      createAccount: record('accounts.createAccount', { userId: OWNER }),
    } as unknown as OpsApiOptions['accounts'],
    revisions: {
      changeSettings: record('revisions.changeSettings'),
    } as unknown as OpsApiOptions['revisions'],
    servers: {
      saveIdentity: record('servers.saveIdentity'),
      changeAddress: record('servers.changeAddress'),
      createFor: record('servers.createFor', { id: SERVER } as MinecraftServer),
      start: record('servers.start'),
      stop: record('servers.stop'),
      deleteServer: record('servers.deleteServer'),
      undeleteServer: record('servers.undeleteServer'),
    } as unknown as OpsApiOptions['servers'],
    notices: {
      changeAddress: record('notices.changeAddress'),
      addressChanged: record('notices.addressChanged'),
      unlisted: record('notices.unlisted'),
    } as unknown as OpsApiOptions['notices'],
    queries: {
      get: record('queries.get', { id: SERVER, status: 'running', version: 4, settings: SETTINGS }),
      access: record('queries.access', {
        entries: [{ list: 'ban', player: { uuid: PLAYER, name: 'Griefer' } }],
      }),
    } as unknown as OpsApiOptions['queries'],
    console: {
      run: record('console.run', 'There are 0 of a max of 5 players online'),
    } as unknown as OpsApiOptions['console'],
    feed: {
      recent: record('feed.recent', [{ at: new Date(0), text: 'Done (2.1s)!', level: 'info' }]),
    } as unknown as OpsApiOptions['feed'],
    mods: {
      search: record('mods.search', {
        total: 1,
        hits: [
          {
            projectId: 'P7dR8mSH',
            slug: 'fabric-api',
            name: 'Fabric API',
            summary: '',
            downloads: 9,
            runsOnServers: true,
            iconUrl: null,
          },
        ],
      }),
      // A project called `clash` doesn't fit the server; anything else does.
      plan: async (...args: [unknown, string, { add?: Array<{ projectId: string }> }]) => {
        calls.push(['mods.plan', ...args])
        return { kind: args[2].add?.some((mod) => mod.projectId === 'clash') ? 'conflicts' : 'ok' }
      },
      apply: record('mods.apply'),
    } as unknown as OpsApiOptions['mods'],
    modQueries: {
      list: record('modQueries.list', { mods: [] }),
      planView: (plan: { kind: string }) =>
        plan.kind === 'ok'
          ? { kind: 'ok', expected: [JAR] }
          : {
              kind: 'conflicts',
              conflicts: [{ kind: 'no_fitting_version', mod: 'Clash', projectId: 'clash' }],
              movesTo: { gameVersion: '26.2' },
            },
    } as unknown as OpsApiOptions['modQueries'],
    access: {
      add: record('access.add'),
      remove: record('access.remove'),
      setWhitelistEnabled: record('access.setWhitelistEnabled'),
    } as unknown as OpsApiOptions['access'],
    moderation: {
      view: record('moderation.view', { enabled: false }),
      setTools: record('moderation.setTools'),
    } as unknown as OpsApiOptions['moderation'],
    listings: {
      setPublic: record('listings.setPublic'),
      markOfficial: record('listings.markOfficial'),
      trustProject: record('listings.trustProject'),
      untrustProject: record('listings.untrustProject'),
    } as unknown as OpsApiOptions['listings'],
    listingQueries: {
      own: record('listingQueries.own', { visibility: 'published' }),
      allowlist: record('listingQueries.allowlist', []),
    } as unknown as OpsApiOptions['listingQueries'],
    platform: {
      view: record('platform.view', { ...CONTROLS, usage: { servers: 3 } }),
      set: record('platform.set'),
      refreshCatalog: record('platform.refreshCatalog', { changed: 2 }),
    } as unknown as OpsApiOptions['platform'],
    flySuspend: {
      view: record('flySuspend.view', { on: true, source: 'default', default: true }),
      set: record('flySuspend.set'),
    } as unknown as OpsApiOptions['flySuspend'],
    jarChecks: {
      list: record('jarChecks.list', [{ sha512: JAR, state: 'quarantined' }]),
      refresh: record('jarChecks.refresh', 1),
      release: record('jarChecks.release'),
    } as unknown as OpsApiOptions['jarChecks'],
    upkeep: {
      rest: record('upkeep.rest'),
      purge: record('upkeep.purge'),
    } as unknown as OpsApiOptions['upkeep'],
    health: {
      view: record('health.view', { at: '2026-10-11T12:00:00.000Z' }),
      operations: record('health.operations', []),
      operation: record('health.operation', { id: SERVER, steps: [] }),
    } as unknown as OpsApiOptions['health'],
  })
}

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

describe('the operators’ API: accounts', () => {
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

  test('makes an account for a person, by their address and name', async () => {
    const made = await call('POST', '/accounts', { email: 'kid@example.test', name: 'Kid' })
    expect(made.status).toBe(201)
    expect(await made.json()).toMatchObject({ userId: OWNER, plan: 'free' })
    expect(named('accounts.createAccount')).toEqual([
      ['accounts.createAccount', ADA, 'kid@example.test', 'Kid'],
    ])
    expect((await call('POST', '/accounts', { email: 'not an address' })).status).toBe(400)
    expect(named('accounts.createAccount')).toHaveLength(1)
  })
})

describe('the operators’ API: servers and health', () => {
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

  test('reads production’s health, and finds operations by kind, age, slowness and outcome', async () => {
    expect((await call('GET', '/health', undefined, 'not-the-token')).status).toBe(401)
    const health = await call('GET', '/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ at: '2026-10-11T12:00:00.000Z' })
    expect(named('health.view')).toEqual([['health.view', ADA]])

    const since = '2026-10-10T00:00:00.000Z'
    const found = await call('GET', `/operations?kind=wake&since=${since}&slow=90&status=succeeded&limit=5`)
    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({ operations: [] })
    expect(named('health.operations')).toEqual([
      ['health.operations', ADA, { kind: 'wake', since, slowerThan: 90, status: 'succeeded', limit: 5 }],
    ])
    expect((await call('GET', '/operations')).status).toBe(200)
    expect(named('health.operations')[1]).toEqual(['health.operations', ADA, { limit: 50 }])
    expect((await call('GET', '/operations?slow=soon')).status).toBe(400)
    expect((await call('GET', '/operations?since=yesterday')).status).toBe(400)

    expect((await call('GET', `/operations/${SERVER}`)).status).toBe(200)
    expect(named('health.operation')).toEqual([['health.operation', ADA, SERVER]])
    expect((await call('GET', '/operations/not-an-id')).status).toBe(400)
  })
})

describe('the operators’ API: a server’s console, identity and mods', () => {
  test('sends a console command, and reads back what the console printed lately', async () => {
    const sent = await call('POST', `/servers/${SERVER}/console`, { command: 'list' })
    expect(await sent.json()).toEqual({ output: 'There are 0 of a max of 5 players online' })
    expect(named('console.run')).toEqual([['console.run', ADA, SERVER, 'list']])
    const read = await call('GET', `/servers/${SERVER}/console?lines=20`)
    expect(await read.json()).toEqual({
      lines: [{ at: new Date(0).toISOString(), text: 'Done (2.1s)!', level: 'info' }],
    })
    await call('GET', `/servers/${SERVER}/console`)
    expect(named('feed.recent')).toEqual([
      ['feed.recent', SERVER, 20],
      ['feed.recent', SERVER, 100],
    ])
    expect((await call('POST', `/servers/${SERVER}/console`, { command: '' })).status).toBe(400)
    expect((await call('GET', `/servers/${SERVER}/console?lines=many`)).status).toBe(400)
  })

  test('sets a server’s identity, address and server list message as its settings pages do', async () => {
    const identity = {
      name: 'Island',
      description: 'Come build with us',
      icon: SERVER_ICONS[0],
      tags: ['survival'],
    }
    expect((await call('PATCH', `/servers/${SERVER}/identity`, identity)).status).toBe(200)
    expect((await call('PUT', `/servers/${SERVER}/address`, { slug: 'Island-Home' })).status).toBe(200)
    expect(calls.filter(([name]) => name.startsWith('servers.'))).toEqual([
      ['servers.saveIdentity', ADA, SERVER, identity],
    ])
    expect(named('notices.changeAddress')).toEqual([['notices.changeAddress', ADA, SERVER, 'island-home']])
    expect((await call('PATCH', `/servers/${SERVER}/identity`, { icon: 'no-such-icon' })).status).toBe(400)
    // A picture of its own is read as the web reads one, so one that isn't a picture is refused.
    const picture = Buffer.from('not a picture').toString('base64')
    expect((await call('PATCH', `/servers/${SERVER}/identity`, { picture })).status).toBe(400)
    expect(named('servers.saveIdentity')).toHaveLength(1)

    // The server list message is one of its settings: changed alone, at the version it was read.
    expect((await call('PUT', `/servers/${SERVER}/message`, { motd: 'Come build with us' })).status).toBe(200)
    const { onlineMode: _, ...game } = SETTINGS
    expect(named('revisions.changeSettings')).toEqual([
      [
        'revisions.changeSettings',
        ADA,
        SERVER,
        { ...game, motd: 'Come build with us' },
        expect.any(String),
        { version: 4 },
      ],
    ])
    expect((await call('PUT', `/servers/${SERVER}/message`, { motd: 'x'.repeat(201) })).status).toBe(400)
  })

  test('tells an owner of a new address or of leaving Browse, for a change made before notices', async () => {
    expect((await call('POST', `/servers/${SERVER}/notice`, { kind: 'address', from: 'beta' })).status).toBe(
      200,
    )
    expect((await call('POST', `/servers/${SERVER}/notice`, { kind: 'unlisted' })).status).toBe(200)
    expect(calls.filter(([name]) => name.startsWith('notices.'))).toEqual([
      ['notices.addressChanged', ADA, SERVER, 'beta'],
      ['notices.unlisted', ADA, SERVER],
    ])
    expect((await call('POST', `/servers/${SERVER}/notice`, { kind: 'address' })).status).toBe(400)
    expect((await call('POST', `/servers/${SERVER}/notice`, { kind: 'renamed' })).status).toBe(400)
    expect(named('notices.addressChanged')).toHaveLength(1)
  })

  test('lists, searches, plans, adds and removes mods as the mods page does', async () => {
    expect((await call('GET', `/servers/${SERVER}/mods`)).status).toBe(200)
    const found = await call('GET', `/servers/${SERVER}/mods/search?text=fabric&offset=20`)
    expect(await found.json()).toEqual({
      total: 1,
      hits: [
        {
          projectId: 'P7dR8mSH',
          slug: 'fabric-api',
          name: 'Fabric API',
          summary: '',
          downloads: 9,
          runsOnServers: true,
        },
      ],
    })
    expect(named('mods.search')).toEqual([
      ['mods.search', ADA, SERVER, { text: 'fabric', offset: 20, limit: 20 }],
    ])
    const add = { add: [{ projectId: 'P7dR8mSH' }] }
    expect(await (await call('POST', `/servers/${SERVER}/mods/plan`, add)).json()).toEqual({
      kind: 'ok',
      expected: [JAR],
    })

    // Applied with the jars it plans to now, unless the caller says which it was shown.
    calls.length = 0
    expect((await call('POST', `/servers/${SERVER}/mods`, add)).status).toBe(200)
    expect(
      (await call('POST', `/servers/${SERVER}/mods`, { remove: ['fabric-api'], expected: [] })).status,
    ).toBe(200)
    expect(named('mods.plan')).toEqual([['mods.plan', ADA, SERVER, add]])
    expect(named('mods.apply')).toEqual([
      ['mods.apply', ADA, SERVER, add, [JAR], expect.any(String), { acknowledgeRevoked: undefined }],
      [
        'mods.apply',
        ADA,
        SERVER,
        { remove: ['fabric-api'] },
        [],
        expect.any(String),
        { acknowledgeRevoked: undefined },
      ],
    ])

    // A change that doesn't fit says why, and what release it fits; nothing is applied.
    const clash = await call('POST', `/servers/${SERVER}/mods`, { add: [{ projectId: 'clash' }] })
    expect(clash.status).toBe(400)
    expect(await clash.json()).toEqual({
      error: {
        code: 'mods_conflict',
        message: "That change doesn't fit this server: Clash. It works on 26.2, with moveTo.",
      },
    })
    expect(named('mods.apply')).toHaveLength(2)
  })
})

describe('the operators’ API: players, Browse and the platform', () => {
  test('keeps the whitelist, operators, bans and helpers, and the moderation tools, as the players page does', async () => {
    expect((await call('GET', `/servers/${SERVER}/access`)).status).toBe(200)
    expect((await call('PUT', `/servers/${SERVER}/access/whitelist`, { enabled: true })).status).toBe(200)
    expect((await call('POST', `/servers/${SERVER}/access/whitelist`, { name: 'Steve' })).status).toBe(200)
    expect((await call('POST', `/servers/${SERVER}/access/operator`, { name: 'Alex' })).status).toBe(200)
    expect(
      (await call('POST', `/servers/${SERVER}/access/ban`, { name: 'Griefer', reason: 'Burned the town' }))
        .status,
    ).toBe(200)
    expect((await call('DELETE', `/servers/${SERVER}/access/ban/griefer`)).status).toBe(200)
    expect((await call('DELETE', `/servers/${SERVER}/access/ban/${PLAYER}`)).status).toBe(200)
    expect(calls.filter(([name]) => name.startsWith('access.'))).toEqual([
      ['access.setWhitelistEnabled', ADA, SERVER, true],
      ['access.add', ADA, SERVER, 'whitelist', 'Steve', undefined],
      ['access.add', ADA, SERVER, 'operator', 'Alex', undefined],
      ['access.add', ADA, SERVER, 'ban', 'Griefer', 'Burned the town'],
      ['access.remove', ADA, SERVER, 'ban', PLAYER],
      ['access.remove', ADA, SERVER, 'ban', PLAYER],
    ])
    expect((await call('DELETE', `/servers/${SERVER}/access/ban/Nobody`)).status).toBe(404)
    expect((await call('POST', `/servers/${SERVER}/access/owners`, { name: 'Steve' })).status).toBe(400)
    expect((await call('POST', `/servers/${SERVER}/access/ban`, { name: 'not a name' })).status).toBe(400)

    expect((await call('GET', `/servers/${SERVER}/moderation`)).status).toBe(200)
    expect(
      (await call('PUT', `/servers/${SERVER}/moderation`, { enabled: true, chatFilter: false })).status,
    ).toBe(200)
    expect(named('moderation.setTools')).toEqual([
      ['moderation.setTools', ADA, SERVER, { enabled: true, chatFilter: false }, expect.any(String)],
    ])
  })

  test('publishes and unlists a server, marks it as run by Cubepals, and keeps the allowlist', async () => {
    expect((await call('PUT', `/servers/${SERVER}/listing`, { public: true })).status).toBe(200)
    expect((await call('PUT', `/servers/${SERVER}/listing`, { public: false })).status).toBe(200)
    expect(
      (await call('PUT', `/servers/${SERVER}/official`, { official: true, reason: 'Our own lobby' })).status,
    ).toBe(200)
    expect((await call('PUT', `/servers/${SERVER}/official`, { official: false })).status).toBe(400)
    expect((await call('POST', '/allowlist', { projectId: 'P7dR8mSH', note: 'Checked' })).status).toBe(201)
    expect((await call('DELETE', '/allowlist/modrinth/P7dR8mSH')).status).toBe(200)
    expect((await call('GET', '/allowlist')).status).toBe(200)
    expect(calls.filter(([name]) => name.startsWith('listings.'))).toEqual([
      ['listings.setPublic', ADA, SERVER, true],
      ['listings.setPublic', ADA, SERVER, false],
      ['listings.markOfficial', ADA, SERVER, true, 'Our own lobby'],
      ['listings.trustProject', ADA, 'P7dR8mSH', 'Checked'],
      ['listings.untrustProject', ADA, 'modrinth', 'P7dR8mSH'],
    ])
  })

  test('reads and sets the platform switches, changing only what it names', async () => {
    expect(await (await call('GET', '/platform')).json()).toMatchObject({ startsEnabled: true })
    expect((await call('PATCH', '/platform', { startsEnabled: false, maxServers: 80 })).status).toBe(200)
    expect(named('platform.set')).toEqual([
      ['platform.set', ADA, { ...CONTROLS, startsEnabled: false, maxServers: 80 }],
    ])
    expect((await call('PATCH', '/platform', { maxServers: -1 })).status).toBe(400)
    expect((await call('PUT', '/platform/fly-suspend', { on: null })).status).toBe(200)
    expect(named('flySuspend.set')).toEqual([['flySuspend.set', ADA, null]])
    expect(await (await call('POST', '/platform/catalog-refresh')).json()).toEqual({ changed: 2 })
    expect(named('platform.refreshCatalog')).toEqual([['platform.refreshCatalog', ADA]])
  })
})

test('lists uploaded jars’ checks, fetches the lists now, and releases a jar by its sha512', async () => {
  expect(await (await call('GET', '/jar-checks?state=quarantined')).json()).toEqual({
    checks: [{ sha512: JAR, state: 'quarantined' }],
  })
  expect((await call('GET', '/jar-checks?state=gone')).status).toBe(400)
  expect(await (await call('POST', '/jar-checks/refresh')).json()).toEqual({ quarantined: 1 })
  expect((await call('POST', `/jar-checks/${JAR}/release`)).status).toBe(200)
  expect((await call('POST', '/jar-checks/not-a-digest/release')).status).toBe(400)
  expect(calls.filter(([name]) => name.startsWith('jarChecks.'))).toEqual([
    ['jarChecks.list', ['quarantined']],
    ['jarChecks.refresh'],
    ['jarChecks.release', ADA, JAR],
  ])
})

test('the mount keeps the control plane’s platform switches when the web’s services ride along', async () => {
  const view = async () => ({ startsEnabled: true })
  const app = { platform: { view }, servers: {} } as unknown as ControlPlane
  // What main.node.ts passes is everything the web's API is given, `platform` included.
  const api = { health: {}, flySuspend: {}, moderation: {}, platform: { capabilities: {} } }
  const apis = operatorApis(app, api as unknown as Parameters<typeof operatorApis>[1], 'operator-token')
  const answer = await apis.fetch(
    new Request('http://internal/ops/v1/platform', { headers: { authorization: 'Bearer operator-token' } }),
  )
  expect(await answer.json()).toEqual({ startsEnabled: true })
})
