// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A player whose game left a modded server as it joined (`left-at-once.ts`): which ends are kept,
 * what the server list and the next join hear, and for how long; then, through the front door to
 * a stand-in mc-router, a game that hangs up on its own a moment after its hand-off, whose next
 * ping says the mods differ, whose next join is told which and goes no further, and whose join
 * after that goes through.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Server } from 'node:net'
import type { EdgeRoute } from '@blockly/contracts/edge'
import { until } from '@blockly/contracts/waits'
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { readProxyHeader } from '../../packages/contracts/src/proxy-header.ts'
import { front } from './front.ts'
import { turnAway } from './hold.ts'
import { LEFT_STATUS, LEFT_TIMES, LeftAtOnce, leftWords } from './left-at-once.ts'
import { Gate, type Limits } from './limits.ts'
import { packet, readVarInt, statusRequest, string, varInt } from './notice.ts'
import type { SessionEnd } from './session-end.ts'
import { sourceKey, Visits } from './visits.ts'

const MODS: NonNullable<EdgeRoute['mods']> = {
  list: [
    { name: 'Collective', version: '26.3.0-8.87-fabric+forge+neo', changed: true },
    { name: 'VeinMiner', version: '2.14.0', changed: true },
    { name: 'AppleSkin', version: '3.0.10+mc26.3' },
  ],
  more: 5,
  changedAt: '2026-11-16T07:52:49.432Z',
}

const route = (fields: Partial<EdgeRoute> = {}): EdgeRoute => ({
  hostname: 'modded.play.test',
  destination: '10.0.0.1:25565',
  mods: MODS,
  ...fields,
})

/** How a session ends: the player's game closed it, cleanly, unless said otherwise. */
const ended = (fields: Partial<SessionEnd> = {}): SessionEnd => ({
  longestQuietMs: 0,
  longestQuietFrom: new Date(0).toISOString(),
  stalls: 0,
  quietAtEndMs: 0,
  longestHeldMs: 0,
  heldStalls: 0,
  heldAtEnd: false,
  mostQueuedUp: 0,
  downQuietAtEndMs: 0,
  mostQueuedDown: 0,
  closedFirst: 'player',
  how: 'closed',
  ...fields,
})

describe('who left as they joined', () => {
  const at = Date.parse('2026-11-16T15:09:29Z')
  const setUp = (routes: EdgeRoute[] = [route()]) => {
    const clock = { now: at }
    const held = { routes }
    const left = new LeftAtOnce(
      (name) => held.routes.find((r) => r.hostname === name),
      LEFT_TIMES,
      () => clock.now,
    )
    const handed = (secondsBefore: number) => new Date(clock.now - secondsBefore * SECOND_MS).toISOString()
    return { clock, held, left, handed }
  }

  test('a game that hangs up by itself as it joins is kept; anything else isn’t', () => {
    const { left, handed } = setUp([route(), route({ hostname: 'plain.play.test', mods: undefined })])
    left.left('modded.play.test', '203.0.113.1', handed(6), ended({ closedFirst: 'server' }))
    left.left('modded.play.test', '203.0.113.2', handed(6), ended({ how: 'reset' }))
    left.left('modded.play.test', '203.0.113.3', handed(60), ended())
    left.left('modded.play.test', '203.0.113.4', undefined, ended())
    left.left('plain.play.test', '203.0.113.5', handed(6), ended())
    expect(left.held()).toBe(0)

    left.left('modded.play.test', '203.0.113.6', handed(6), ended())
    expect(left.held()).toBe(1)
    // Another address, or another server, hears nothing of it.
    expect(left.join('modded.play.test', '203.0.113.7')).toBeNull()
    expect(left.status('plain.play.test', '203.0.113.6')).toBeNull()
  })

  test('its server list says so, and its next join is told which, once', () => {
    const { left, handed } = setUp()
    left.left('modded.play.test', '203.0.113.1', handed(3), ended())
    expect(left.status('modded.play.test', '203.0.113.1')).not.toBeNull()
    expect(left.status('modded.play.test', '203.0.113.1')).not.toBeNull()
    expect(left.join('modded.play.test', '203.0.113.1')).toBe(leftWords(MODS, new Date(at)))
    expect(left.join('modded.play.test', '203.0.113.1')).toBeNull()
    expect(left.status('modded.play.test', '203.0.113.1')).toBeNull()
  })

  test('it is said for ten minutes, while the server still lists mods, and the list only while it runs', () => {
    const { clock, held, left, handed } = setUp()
    left.left('modded.play.test', '203.0.113.1', handed(3), ended())
    left.left('modded.play.test', '203.0.113.2', handed(3), ended())
    left.left('modded.play.test', '203.0.113.3', handed(3), ended())
    held.routes = [route({ state: 'asleep' })]
    // A sleeping server's list is the agent's own; its join is still told.
    expect(left.status('modded.play.test', '203.0.113.1')).toBeNull()
    expect(left.join('modded.play.test', '203.0.113.1')).not.toBeNull()
    held.routes = [route({ mods: undefined })]
    expect(left.join('modded.play.test', '203.0.113.2')).toBeNull()
    held.routes = [route()]
    clock.now += 10 * MINUTE_MS
    expect(left.join('modded.play.test', '203.0.113.3')).toBeNull()
    expect(left.held()).toBe(0)
  })

  test('the words say which versions, what changed when, and what to do in each launcher', () => {
    expect(leftWords(MODS, new Date(at)).split('\n')).toEqual([
      'Your mods don’t match this server’s.',
      'That’s why your game left as soon as it joined.',
      '',
      'Its mods changed on 16 Nov. It runs:',
      'Collective 26.3.0-8.87-fabric+forge+neo',
      'VeinMiner 2.14.0',
      'AppleSkin 3.0.10+mc26.3',
      'and 5 more',
      '',
      'Update yours to these versions, then join again:',
      'Modrinth App or CurseForge: open the profile, update its mods.',
      'Prism Launcher: Edit, Mods, Check for updates.',
      'Minecraft Launcher: put each at that version in your mods folder.',
    ])
    // A change from another year says its year; a server whose mods never changed says none.
    expect(leftWords({ ...MODS, changedAt: '2025-03-02T10:00:00Z' }, new Date(at))).toContain(
      'Its mods changed on 2 Mar 2025. It runs:',
    )
    const { changedAt: _, ...unchanged } = MODS
    expect(leftWords(unchanged, new Date(at)).split('\n')[3]).toBe('It runs:')
    const pack = { list: [{ name: 'Better MC', version: 'v52' }], pack: true as const }
    expect(leftWords(pack, new Date(at)).split('\n')).toEqual([
      'Your pack doesn’t match this server’s.',
      'That’s why your game left as soon as it joined.',
      '',
      'It plays:',
      'Better MC v52',
      '',
      'Update the pack to that version in your launcher, then join again.',
    ])
  })
})

describe('through the front door', () => {
  const open: Server[] = []
  afterEach(() => {
    for (const server of open.splice(0)) server.close()
  })

  const listening = (server: Server) =>
    new Promise<number>((resolve) =>
      server.once('listening', () => resolve((server.address() as AddressInfo).port)),
    )

  /** A join's first bytes: the handshake and the start of login. */
  const joinRequest = (address: string) =>
    Uint8Array.from([
      ...packet(0, [...varInt(767), ...string(address), 0x63, 0xdd, 2]),
      ...packet(0, string('Alex')),
    ])

  const ROOMY: Limits = {
    address: { connections: { perSecond: 100, burst: 100 }, greeting: 100, open: 100 },
    server: { connections: { perSecond: 100, burst: 100 }, open: 100 },
  }

  /** Who a connection to the stand-in mc-router is from, and what its handshake intends, once both are whole. */
  function greetingOf(bytes: Uint8Array): { source: string; intent: number } | null {
    const header = readProxyHeader(bytes)
    if (typeof header === 'string' || header.source === null) return null
    const rest = bytes.subarray(header.next)
    const length = readVarInt(rest, 0)
    if (length === null || rest.length < length.next + length.value) return null
    const intent = rest[length.next + length.value - 1] ?? 0
    return { source: sourceKey(header.source.address, header.source.port), intent }
  }

  /** The status a stand-in server answers a ping with. */
  const STATUS = packet(
    0,
    string(JSON.stringify({ version: { name: '26.3', protocol: 776 }, description: 'Hi' })),
  )

  test('a game that leaves as it joins hears why at its next ping and join, then goes through', async () => {
    const visits = new Visits(() => undefined, { edgeId: 'edge-1', region: 'fra' })
    const joins: string[] = []
    // A stand-in mc-router: tells the visit it handed the join over, as its webhook does, and
    // answers a ping with the server's status.
    const router = createServer((socket) => {
      let got = new Uint8Array(0)
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        got = Uint8Array.from([...got, ...chunk])
        const greeting = greetingOf(got)
        if (greeting === null) return
        if (greeting.intent === 1) return void socket.end(STATUS)
        if (!joins.includes(greeting.source)) joins.push(greeting.source)
        visits.update(greeting.source, { path: 'direct', handedAt: new Date().toISOString() })
      })
    }).listen(0, '127.0.0.1')
    open.push(router)
    const routes = [route()]
    const left = new LeftAtOnce((name) => routes.find((r) => r.hostname === name))
    const door = front({
      port: 0,
      router: await listening(router),
      proxied: false,
      gate: new Gate(ROOMY),
      known: (hostname) => hostname.endsWith('.play.test'),
      plain: () => false,
      busy: 'Busy',
      refuse: () => null,
      timeouts: { connectMs: 1_000, idleMs: 60_000 },
      visits,
      leftAtOnce: left,
    })
    open.push(door)
    const port = await listening(door)

    /** Sends `bytes`, and resolves with all the door answered once it closed, or `afterMs` passed. */
    const dial = (bytes: Uint8Array, afterMs = 1_000) =>
      new Promise<Uint8Array>((resolve) => {
        const chunks: Buffer[] = []
        const socket = connect({ host: '127.0.0.1', port }, () => socket.write(bytes))
        socket.on('data', (chunk) => chunks.push(chunk))
        socket.on('error', () => undefined)
        socket.on('close', () => resolve(new Uint8Array(Buffer.concat(chunks))))
        const ending = setTimeout(() => socket.end(), afterMs)
        socket.once('close', () => clearTimeout(ending))
      })

    // Before anything happened, a ping hears the server's own answer.
    expect(new TextDecoder().decode(await dial(statusRequest('modded.play.test', 25565)))).toContain('Hi')

    // The game is handed over, then hangs up on its own, as one that can't read the server does.
    const first = dial(joinRequest('modded.play.test'), 300)
    await until('the join to be handed over', () => joins.length === 1)
    await first
    await until('the game to be kept as one that left as it joined', () => left.held() === 1)

    const ping = await dial(statusRequest('modded.play.test', 25565))
    expect(new TextDecoder().decode(ping)).toContain(JSON.stringify(LEFT_STATUS).slice(1, -1))

    const told = await dial(joinRequest('modded.play.test'))
    expect(told).toEqual(turnAway(leftWords(MODS, new Date())))
    expect(joins).toHaveLength(1)

    // The next goes through: nothing is kept from a player on what the edge only infers.
    void dial(joinRequest('modded.play.test'), 300)
    await until('the join after to reach the server', () => joins.length === 2)
  })
})
