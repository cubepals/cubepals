// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Edge wire schemas preserve supported messages and refuse malformed, ambiguous and out-of-bound input. */
import { expect, test } from 'bun:test'

const destination = '127.0.0.1:25565'
const hostname = 'maple.play.test'

test('the v1 wake endpoint accepts the longest Java name but refuses the next character', async () => {
  const { EDGE_PROTOCOL_BASE, WakeRequest } = await import('./edge.ts')
  const name = 'abcdefghijklmnop'
  const message = { hostname, name, address: '203.0.113.7', understands: ['failed', 'broken', 'asleep'] }
  const request = new Request(new URL(`${EDGE_PROTOCOL_BASE}/wake`, 'https://control.invalid').href, {
    method: 'POST',
    body: JSON.stringify(message),
  })
  expect(new URL(request.url).pathname).toBe('/edge/v1/wake')
  expect(WakeRequest.parse(message)).toEqual(message)
  expect(WakeRequest.parse({ hostname })).toEqual({ hostname })
  expect(WakeRequest.safeParse({ ...message, name: `${name}q` }).success).toBe(false)
  for (const invalid of [
    null,
    {},
    { hostname: 1 },
    { hostname, understands: [1] },
    { hostname, address: null },
  ]) {
    expect(WakeRequest.safeParse(invalid).success).toBe(false)
  }
})

test('routes retain every supported optional field and every documented state', async () => {
  const { EdgeRoute, EdgeRoutes } = await import('./edge.ts')
  const route = {
    hostname,
    destination,
    aliasOf: 'maple',
    state: 'asleep',
    trialOver: true,
    name: 'Maple',
    waking: true,
    wakeSeconds: 1,
    motd: 'Welcome home',
    icon: 'https://cubepals.com/icon.png',
    proxyProtocol: true,
    // A simulated release range: the contract validates integers, not a particular Minecraft release table.
    joins: { release: 'fixture-release', protocol: 7, oldest: 5, newest: 7 },
  } as const
  expect(EdgeRoute.parse(route)).toEqual(route)
  expect(EdgeRoute.parse({ ...route, state: 'restarting' })).toEqual({ ...route, state: 'restarting' })
  expect(EdgeRoute.parse({ hostname, destination })).toEqual({ hostname, destination })
  const releases = [{ name: 'fixture-release', protocol: 7 }]
  expect(EdgeRoutes.parse({ routes: [route], releases })).toEqual({ routes: [route], releases })
  expect(EdgeRoutes.parse({ routes: [] })).toEqual({ routes: [] })
  expect(EdgeRoutes.safeParse({ releases }).success).toBe(false)
})

test('wake estimates and join protocols are integers and presence flags cannot falsely claim true', async () => {
  const { EdgeRoute, EdgeRoutes } = await import('./edge.ts')
  const route = { hostname, destination }
  for (const wakeSeconds of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
    expect(EdgeRoute.safeParse({ ...route, wakeSeconds }).success).toBe(false)
  }
  for (const flag of ['trialOver', 'waking', 'proxyProtocol']) {
    expect(EdgeRoute.safeParse({ ...route, [flag]: false }).success).toBe(false)
  }
  for (const invalid of [{ state: 'ready' }, { icon: '/relative.png' }, { icon: 'not a URL' }]) {
    expect(EdgeRoute.safeParse({ ...route, ...invalid }).success).toBe(false)
  }
  for (const field of ['protocol', 'oldest', 'newest']) {
    const joins = { release: 'fixture-release', protocol: 7, oldest: 5, newest: 7, [field]: 0.5 }
    expect(EdgeRoute.safeParse({ ...route, joins }).success).toBe(false)
  }
  expect(
    EdgeRoutes.safeParse({ routes: [], releases: [{ name: 'fixture-release', protocol: 0.5 }] }).success,
  ).toBe(false)
})

test('wake outcomes retain their discriminated data, including denied and queued alternatives', async () => {
  const { WakeResult } = await import('./edge.ts')
  const ready = { outcome: 'ready', destination, proxyProtocol: true, wakeOperationId: 'wake-1' } as const
  expect(WakeResult.parse(ready)).toEqual(ready)
  expect(WakeResult.parse({ outcome: 'ready', destination })).toEqual({ outcome: 'ready', destination })
  for (const behind of ['rest', 'stop', 'backup'] as const) {
    const starting = { outcome: 'starting', behind, wakeOperationId: 'wake-2' } as const
    expect(WakeResult.parse(starting)).toEqual(starting)
  }
  for (const outcome of ['starting', 'restarting', 'asleep'] as const) {
    expect(WakeResult.parse({ outcome })).toEqual({ outcome })
  }
  for (const reason of ['unknown', 'suspended', 'paused', 'quota', 'deleted', 'failed', 'broken'] as const) {
    const denied = { outcome: 'denied', reason, trialOver: true, name: 'Maple' } as const
    expect(WakeResult.parse(denied)).toEqual(denied)
    expect(WakeResult.parse({ outcome: 'denied', reason })).toEqual({ outcome: 'denied', reason })
  }
  for (const message of [
    {},
    { outcome: 'ready' },
    { outcome: 'ready', destination, proxyProtocol: false },
    { outcome: 'denied' },
    { outcome: 'denied', reason: 'surprise' },
    { outcome: 'denied', reason: 'quota', trialOver: false },
    { outcome: 'starting', behind: 'surprise' },
    { outcome: 'surprise' },
  ]) {
    expect(WakeResult.safeParse(message).success).toBe(false)
  }
})

test('ping and idle messages require a hostname and a ping answer must carry an actual boolean', async () => {
  const { IdleHint, PingWakeRequest, PingWakeResult } = await import('./edge.ts')
  expect(IdleHint.parse({ hostname })).toEqual({ hostname })
  expect(IdleHint.safeParse({}).success).toBe(false)
  expect(PingWakeRequest.parse({ hostname })).toEqual({ hostname })
  expect(PingWakeRequest.parse({ hostname, address: '203.0.113.7' })).toEqual({
    hostname,
    address: '203.0.113.7',
  })
  expect(PingWakeRequest.safeParse({}).success).toBe(false)
  expect(PingWakeRequest.safeParse({ hostname, address: null }).success).toBe(false)
  for (const waking of [false, true]) expect(PingWakeResult.parse({ waking })).toEqual({ waking })
  for (const invalid of [{}, { waking: 'false' }, { waking: 0 }, null]) {
    expect(PingWakeResult.safeParse(invalid).success).toBe(false)
  }
})

test('session events retain player identity and refuse unknown events and non-UTC timestamps', async () => {
  const { SessionEvent } = await import('./edge.ts')
  const at = new Date(Date.UTC(2024, 1, 29, 12)).toISOString()
  for (const event of ['connect', 'disconnect'] as const) {
    const minimal = { edgeId: 'edge-1', hostname, event, at }
    const full = { ...minimal, player: { name: 'Player', uuid: 'reported-id' }, address: '203.0.113.7' }
    expect(SessionEvent.parse(minimal)).toEqual(minimal)
    expect(SessionEvent.parse(full)).toEqual(full)
  }
  for (const patch of [
    { edgeId: undefined },
    { hostname: undefined },
    { event: 'join' },
    { at: 'not a date' },
    { at: '2024-02-30T12:00:00Z' },
    { at: '2024-02-29T12:00:00' },
    { player: { name: 'Player' } },
    { player: { uuid: 'reported-id' } },
  ]) {
    expect(
      SessionEvent.safeParse({ edgeId: 'edge-1', hostname, event: 'connect', at, ...patch }).success,
    ).toBe(false)
  }
})
