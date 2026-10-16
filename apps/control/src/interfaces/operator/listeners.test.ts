// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the operators' API can be reached, and with what: every `/ops/v1` route, as the API itself
 * lists them, so a route added later is held to the same. On the internal listener each one asks
 * for the token before anything; on the public listener, the one the web and game runtimes reach,
 * none of them is there at all, token or not.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createBillingWebhook } from '../billing/webhook.ts'
import { createApiApp } from '../http/api.ts'
import { createRuntimeApp } from '../runtime/artifacts.ts'
import type { Services } from '../trpc/trpc.ts'
import { OPS_BASE } from './gate.ts'
import { operatorApis } from './mount.ts'
import { createOpsApi, type OpsApiOptions } from './ops.ts'

const TOKEN = 'operator-token'
const SERVER = '0d2f4e6a-8b1c-4d3e-9f50-a1b2c3d4e5f6'

/** Every route the operators' API answers, with its parameters filled in, over no services at all. */
const routes = createOpsApi({ token: TOKEN } as unknown as OpsApiOptions)
  .routes.filter(({ method, path }) => method !== 'ALL' && path.startsWith(`${OPS_BASE}/`))
  .map(({ method, path }) => ({
    method,
    path: path
      .replace(':id', SERVER)
      .replace(':account', 'owner@example.test')
      .replace(':list', 'ban')
      .replace(':player', 'Griefer')
      .replace(':catalog', 'modrinth')
      .replace(':project', 'P7dR8mSH')
      .replace(':sha512', 'a'.repeat(128)),
  }))

const request = (method: string, path: string, token?: string) =>
  new Request(`http://listener${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      'x-operator': 'ada',
      'content-type': 'application/json',
    },
    ...(method === 'GET' ? {} : { body: '{}' }),
  })

test('the list covers the routes this API was given, the new ones included', () => {
  const listed = routes.map(({ method, path }) => `${method} ${path}`)
  for (const route of [
    'POST /ops/v1/accounts',
    `POST /ops/v1/servers/${SERVER}/trash`,
    `POST /ops/v1/servers/${SERVER}/purge`,
    `POST /ops/v1/servers/${SERVER}/console`,
    `PATCH /ops/v1/servers/${SERVER}/identity`,
    `PUT /ops/v1/servers/${SERVER}/message`,
    `POST /ops/v1/servers/${SERVER}/mods`,
    `POST /ops/v1/servers/${SERVER}/access/ban`,
    `PUT /ops/v1/servers/${SERVER}/listing`,
    'DELETE /ops/v1/allowlist/modrinth/P7dR8mSH',
    'PATCH /ops/v1/platform',
    'PUT /ops/v1/platform/fly-suspend',
    `POST /ops/v1/jar-checks/${'a'.repeat(128)}/release`,
  ])
    expect(listed).toContain(route)
  expect(routes.every(({ path }) => !path.includes(':'))).toBe(true)
})

describe('on the internal listener', () => {
  // The services are missing: a request that got past the gate would fail with a 500, not a 401.
  const internal = operatorApis(
    { servers: {} } as unknown as Parameters<typeof operatorApis>[0],
    {} as unknown as Parameters<typeof operatorApis>[1],
    TOKEN,
  )

  test('every route answers 401 without the token, or with another, before it reaches anything', async () => {
    for (const { method, path } of routes)
      for (const token of [undefined, '', 'not-the-token', `${TOKEN}-but-longer`, TOKEN.toUpperCase()]) {
        const answer = await internal.fetch(request(method, path, token))
        expect({ route: `${method} ${path}`, status: answer.status }).toEqual({
          route: `${method} ${path}`,
          status: 401,
        })
        expect(await answer.json()).toEqual({ error: 'unauthorized' })
      }
  })
})

describe('on the public listener', () => {
  // Built as main.node.ts builds the api role's listener: the web's API, the runtimes' jars and
  // the billing webhooks.
  const services = { insight: { report: () => {} } } as unknown as Services
  const api = createApiApp({
    auth: {
      handle: async () => new Response(null, { status: 404 }),
      sessionOf: async () => null,
      switchFor: () => ({ impersonate: async () => {}, stopImpersonating: async () => {} }),
    },
    methods: { google: false, github: false, turnstileSiteKey: null },
    addresses: { proxySecret: null, hostHeader: null },
    origins: ['https://blockly.test'],
    services,
  })
  api.route('/', createRuntimeApp({ artifacts: {} as Parameters<typeof createRuntimeApp>[0]['artifacts'] }))
  api.route(
    '/',
    createBillingWebhook({ billing: {} as Parameters<typeof createBillingWebhook>[0]['billing'] }),
  )

  test('every /ops/v1 route answers 404, with the token or without it', async () => {
    for (const { method, path } of routes)
      for (const token of [undefined, TOKEN]) {
        const answer = await api.fetch(request(method, path, token))
        expect({ route: `${method} ${path}`, status: answer.status }).toEqual({
          route: `${method} ${path}`,
          status: 404,
        })
      }
  })

  test('main.node.ts mounts the operators’ APIs on the internal listener and nowhere else', () => {
    const main = readFileSync(new URL('../../main.node.ts', import.meta.url), 'utf8')
    const mounts = main.split('\n').filter((line) => line.includes('operatorApis('))
    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatch(
      /^\s*if \(config\.operatorToken !== null\) internal\.route\('\/', operatorApis\(/,
    )
  })
})
