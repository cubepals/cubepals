// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A player whose game left a modded server as it joined (`left-at-once.ts`): which ends are kept,
 * what the server list says, and for how long; then, through the front door to a stand-in
 * mc-router, a game that hangs up on its own a moment after its hand-off, whose next ping says its
 * mods may not match, and whose next join goes through: no join is turned away on a guess.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Server } from 'node:net'
import type { EdgeRoute } from '@blockly/contracts/edge'
import { stays, until } from '@blockly/contracts/waits'
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { motdLayout } from '../../packages/contracts/src/motd-layout.ts'
import { readProxyHeader } from '../../packages/contracts/src/proxy-header.ts'
import { front } from './front.ts'
import { LEFT_TIMES, LeftAtOnce, leftStatus } from './left-at-once.ts'
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
    expect(left.status('modded.play.test', '203.0.113.7')).toBeNull()
    expect(left.status('plain.play.test', '203.0.113.6')).toBeNull()
  })

  test('its server list says so for ten minutes, while the server runs and still lists mods', () => {
    const { clock, held, left, handed } = setUp()
    left.left('modded.play.test', '203.0.113.1', handed(3), ended())
    left.left('modded.play.test', '203.0.113.2', handed(3), ended())
    // As often as the list asks: a ping uses nothing up.
    expect(left.status('modded.play.test', '203.0.113.1')).not.toBeNull()
    expect(left.status('modded.play.test', '203.0.113.1')).not.toBeNull()
    // A sleeping server's list is the agent's own.
    held.routes = [route({ state: 'asleep' })]
    expect(left.status('modded.play.test', '203.0.113.1')).toBeNull()
    held.routes = [route({ mods: undefined })]
    expect(left.status('modded.play.test', '203.0.113.2')).toBeNull()
    held.routes = [route()]
    expect(left.status('modded.play.test', '203.0.113.1')).not.toBeNull()
    clock.now += 10 * MINUTE_MS
    expect(left.status('modded.play.test', '203.0.113.1')).toBeNull()
    expect(left.held()).toBe(0)
  })

  test('the words say the mods may not match, and which versions, as many as the list holds', () => {
    // What the last change moved comes first; what doesn't fit is counted.
    expect(leftStatus(MODS)).toBe(
      'Your mods may not match. It runs Collective 26.3.0-8.87-fabric+forge+neo and 7 more.',
    )
    const short = { list: [MODS.list[1], { name: 'AppleSkin', version: '3.0.10' }] } as typeof MODS
    expect(leftStatus(short)).toBe('Your mods may not match. It runs VeinMiner 2.14.0 and AppleSkin 3.0.10.')
    const pack = { list: [{ name: 'Better MC', version: 'v52' }], pack: true as const }
    expect(leftStatus(pack)).toBe('Your pack may not match. It plays Better MC v52.')
    // A name too long for the list is counted rather than cut.
    const long = { list: [{ name: 'X'.repeat(64), version: 'Y'.repeat(64) }] }
    expect(leftStatus(long)).toBe('Your mods may not match. It runs one mod.')
    for (const mods of [MODS, short, pack, long]) expect(motdLayout(leftStatus(mods)).cutCount).toBe(0)
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

  /**
   * The front door before a stand-in mc-router, which answers a ping with the server's status and,
   * where it `reports`, tells the visit it handed a join over, as its webhook does.
   */
  async function door(routes: EdgeRoute[], reports: boolean) {
    const visits = new Visits(() => undefined, { edgeId: 'edge-1', region: 'fra' })
    const joins: string[] = []
    const handed = (source: string) =>
      reports && visits.update(source, { path: 'direct', handedAt: new Date().toISOString() })
    const router = createServer((socket) => {
      let got = new Uint8Array(0)
      socket.on('error', () => undefined)
      socket.on('data', (chunk) => {
        got = Uint8Array.from([...got, ...chunk])
        const greeting = greetingOf(got)
        if (greeting === null) return
        if (greeting.intent === 1) return void socket.end(STATUS)
        if (!joins.includes(greeting.source)) joins.push(greeting.source)
        handed(greeting.source)
      })
    }).listen(0, '127.0.0.1')
    open.push(router)
    const left = new LeftAtOnce((name) => routes.find((r) => r.hostname === name))
    const listener = front({
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
    open.push(listener)
    const port = await listening(listener)
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
    return { joins, left, dial }
  }

  test('a game that leaves as it joins hears at its next ping that its mods may not match, and its next join goes through', async () => {
    const { joins, left, dial } = await door([route()], true)

    // Before anything happened, a ping hears the server's own answer.
    expect(new TextDecoder().decode(await dial(statusRequest('modded.play.test', 25565)))).toContain('Hi')

    // The game is handed over, then hangs up on its own, as one that can't read the server does.
    const first = dial(joinRequest('modded.play.test'), 300)
    await until('the join to be handed over', () => joins.length === 1)
    await first
    await until('the game to be kept as one that left as it joined', () => left.held() === 1)

    const ping = await dial(statusRequest('modded.play.test', 25565))
    expect(new TextDecoder().decode(ping)).toContain(JSON.stringify(leftStatus(MODS)).slice(1, -1))

    // The next join goes straight through: the edge can't see a game's mods, and turns nobody
    // away on what it only infers.
    void dial(joinRequest('modded.play.test'), 300)
    await until('the next join to reach the server', () => joins.length === 2)
    expect(left.held()).toBe(1)
  })

  test('a join to a running server counts from its hand-off even when mc-router’s word of it comes late', async () => {
    const { joins, left, dial } = await door([route()], false)
    const first = dial(joinRequest('modded.play.test'), 300)
    await until('the join to reach the server', () => joins.length === 1)
    await first
    await until('the game to be kept as one that left as it joined', () => left.held() === 1)
  })

  test('a join held for a sleeping server and never handed over isn’t kept', async () => {
    const { joins, left, dial } = await door([route({ state: 'asleep' })], false)
    const first = dial(joinRequest('modded.play.test'), 300)
    await until('the join to reach the waiting room', () => joins.length === 1)
    await first
    await stays('nothing to be kept', () => left.held() === 0, 300)
  })
})
