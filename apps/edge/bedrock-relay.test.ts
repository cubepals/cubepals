// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The Bedrock relay, between a stand-in for a player and a stand-in for Geyser. */

import { afterEach, expect, test } from 'bun:test'
import { readProxyHeader } from '../../packages/contracts/src/proxy-header.ts'
import { bedrockRelay, isPing, type Open, pongFor, type Relay, type RelayOptions } from './bedrock-relay.ts'

const MAGIC = Uint8Array.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
])

function ping(time: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes[0] = 0x01
  new DataView(bytes.buffer).setBigInt64(1, BigInt(time))
  bytes.set(MAGIC, 9)
  return bytes
}

function pong(text: string): Uint8Array {
  const body = new TextEncoder().encode(text)
  const bytes = new Uint8Array(35 + body.length)
  bytes[0] = 0x1c
  bytes.set(MAGIC, 17)
  new DataView(bytes.buffer).setUint16(33, body.length)
  bytes.set(body, 35)
  return bytes
}

function openRequest(): Uint8Array {
  const bytes = new Uint8Array(1 + 16 + 1 + 100)
  bytes[0] = 0x05
  bytes.set(MAGIC, 1)
  bytes[17] = 11
  return bytes
}

type Udp = Bun.udp.Socket<'buffer'>
interface Heard {
  bytes: Uint8Array
  port: number
}

/** A socket that records what it is sent, and answers pings as Geyser does, once they say whose. */
async function listener(
  onData?: (socket: Udp, bytes: Uint8Array, port: number) => void,
  hostname = '127.0.0.1',
) {
  const heard: Heard[] = []
  const socket = await Bun.udpSocket({
    hostname,
    socket: {
      data(self, bytes, port) {
        heard.push({ bytes: Uint8Array.from(bytes), port })
        onData?.(self, bytes, port)
      },
    },
  })
  return { socket, heard }
}

const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

/**
 * A relay in front of a stand-in Geyser that answers any ping behind a header with `MCPE;Test`. With
 * `strict`, it behaves as Geyser measured: a source says whose it is with its first datagram, and
 * what it sends after that, a header again included, is read as the game's own, so a ping that
 * repeats the header is not answered. It forgets a source that sends nothing for `memoryMs`, and
 * answers nothing while `down`.
 */
async function relayed(options: Partial<RelayOptions> = {}, strict = false, memoryMs = Infinity) {
  const sources = new Map<number, number>()
  const state = { down: false }
  /** Whether strict Geyser reads a datagram: a header from a source it doesn't know, none from one it does. */
  const reads = (port: number, headed: boolean): boolean => {
    const heardAt = sources.get(port)
    const known = heardAt !== undefined && Date.now() - heardAt < memoryMs
    if (!known) sources.delete(port)
    if (known || headed) sources.set(port, Date.now())
    return headed !== known
  }
  const geyser = await listener((socket, bytes, port) => {
    const header = readProxyHeader(bytes)
    if (state.down || (strict && !reads(port, typeof header === 'object'))) return
    const rest = typeof header === 'object' ? bytes.subarray(header.next) : bytes
    if (rest[0] === 0x01) socket.send(pong('MCPE;Test'), port, '127.0.0.1')
    else if (rest[0] === 0x05) socket.send(Uint8Array.of(0x06), port, '127.0.0.1')
  })
  // The port a relay is asked for is taken before it is used, so one is found first.
  const probe = await Bun.udpSocket({ hostname: '127.0.0.1' })
  const publicPort = probe.port
  probe.close()
  const relay: Relay = await bedrockRelay({
    bind: { hostname: '127.0.0.1', port: publicPort },
    geyser: { hostname: '127.0.0.1', port: geyser.socket.port },
    pongs: { perSecond: 0, burst: 2 },
    totalPongs: { perSecond: 0, burst: 3 },
    opens: { perSecond: 0, burst: 3 },
    perAddress: 10,
    most: 10,
    idleMs: 60_000,
    pongRefreshMs: 60_000,
    ...options,
  })
  closers.push(
    () => relay.close(),
    () => geyser.socket.close(),
  )
  const player = await listener()
  closers.push(() => player.socket.close())
  return { relay, geyser, player, port: publicPort, sources, state }
}

test('a ping is answered from the pong Geyser gave, with the time the ping carried', async () => {
  const { player, port } = await relayed()
  await Bun.sleep(100)
  player.socket.send(ping(123456), port, '127.0.0.1')
  await Bun.sleep(100)
  expect(player.heard).toHaveLength(1)
  const answer = player.heard[0]?.bytes ?? new Uint8Array()
  expect(Array.from(answer.subarray(1, 9))).toEqual(Array.from(ping(123456).subarray(1, 9)))
  expect(new TextDecoder().decode(answer.subarray(35))).toBe('MCPE;Test')
})

test('an address is sent only so many pongs, and the pings that go unanswered never reach Geyser', async () => {
  const { player, geyser, port } = await relayed()
  await Bun.sleep(100)
  const asked = geyser.heard.length
  for (let i = 0; i < 6; i++) player.socket.send(ping(i), port, '127.0.0.1')
  await Bun.sleep(150)
  expect(player.heard).toHaveLength(2)
  expect(geyser.heard).toHaveLength(asked)
})

test('a player’s first datagram reaches Geyser behind a header naming them, and the replies come back', async () => {
  const { player, geyser, port, relay } = await relayed()
  await Bun.sleep(100)
  player.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(100)
  const first = geyser.heard.find((h) => h.bytes.length > 100)
  const bytes = first?.bytes ?? new Uint8Array()
  // PROXY v2, UDP over IPv4 (0x12), then the player's address and port.
  expect(bytes[12]).toBe(0x21)
  expect(bytes[13]).toBe(0x12)
  expect(Array.from(bytes.subarray(16, 20))).toEqual([127, 0, 0, 1])
  expect(((bytes[24] ?? 0) << 8) + (bytes[25] ?? 0)).toBe(player.socket.port)
  expect(player.heard.map((h) => h.bytes[0])).toEqual([0x06])
  expect(relay.players()).toBe(1)

  // Later datagrams go as they came: Geyser keeps who the first said.
  const next = Uint8Array.of(0x84, 1, 2, 3)
  player.socket.send(next, port, '127.0.0.1')
  await Bun.sleep(100)
  expect(Array.from(geyser.heard.at(-1)?.bytes ?? [])).toEqual(Array.from(next))
  // And from the same upstream socket, so Geyser sees one peer.
  expect(geyser.heard.at(-1)?.port).toBe(first?.port)
})

test('a datagram that doesn’t open a connection makes no player, and an address opens only so many', async () => {
  const { player, port, relay } = await relayed()
  await Bun.sleep(100)
  player.socket.send(Uint8Array.of(0x84, 1, 2, 3), port, '127.0.0.1')
  await Bun.sleep(50)
  expect(relay.players()).toBe(0)
  // Three opens from one address are allowed; the same port is one player, so use several.
  const others = await Promise.all([1, 2, 3, 4].map(() => listener()))
  closers.push(...others.map((o) => () => o.socket.close()))
  for (const other of others) other.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(150)
  expect(relay.players()).toBe(3)
})

test('each datagram that opens a connection is told: a player made, or why not', async () => {
  const outcomes: Open[] = []
  const { port, relay, state } = await relayed({ opened: (outcome) => outcomes.push(outcome) })
  await Bun.sleep(100)
  // Three opens from one address are allowed; the fourth is one too many.
  const others = await Promise.all([1, 2, 3, 4].map(() => listener()))
  closers.push(...others.map((o) => () => o.socket.close()))
  for (const other of others) other.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(150)
  // A player's next datagram is theirs, not another open.
  const [first] = others
  first?.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(50)
  expect(outcomes).toEqual(['opened', 'opened', 'opened', 'too_many'])

  // Geyser gone, a newcomer is refused, and that is told too.
  state.down = true
  relay.forget()
  const late = await listener()
  closers.push(() => late.socket.close())
  late.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(50)
  expect(outcomes.at(-1)).toBe('not_ready')
})

test('an address holds only so many players, and one dropped frees its place', async () => {
  const { port, relay } = await relayed({
    opens: { perSecond: 0, burst: 10 },
    perAddress: 2,
    idleMs: 150,
    sweepMs: 30,
  })
  await Bun.sleep(100)
  const others = await Promise.all([1, 2, 3].map(() => listener()))
  closers.push(...others.map((o) => () => o.socket.close()))
  for (const other of others) other.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(100)
  expect(relay.players()).toBe(2)
  const left = others.filter((other) => opened(other) === 0)
  expect(left).toHaveLength(1)
  // Quiet past the idle time, both are dropped, and the address may hold players again.
  await Bun.sleep(300)
  expect(relay.players()).toBe(0)
  left[0]?.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(100)
  expect(relay.players()).toBe(1)
  expect(opened(left[0] ?? { heard: [] })).toBe(1)
})

test('a quiet player is dropped', async () => {
  const { player, port, relay } = await relayed({ idleMs: 150, sweepMs: 30 })
  await Bun.sleep(100)
  player.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(30)
  expect(relay.players()).toBe(1)
  await Bun.sleep(300)
  expect(relay.players()).toBe(0)
})

/** How many times `player` has been answered an open request: Geyser's reply is 0x06. */
const opened = (player: { heard: Heard[] }) => player.heard.filter((h) => h.bytes[0] === 0x06).length

test('a player quiet for as long as Geyser keeps their header gets in when they open again', async () => {
  // Geyser forgets the source at 200 ms; the sweep comes far too late to save them.
  const { player, port } = await relayed({ idleMs: 150 }, true, 200)
  await Bun.sleep(100)
  player.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(50)
  expect(opened(player)).toBe(1)
  // Geyser's replies come and go meanwhile; only what the player sends keeps their header.
  await Bun.sleep(250)
  for (let i = 0; i < 3; i++) {
    player.socket.send(openRequest(), port, '127.0.0.1')
    await Bun.sleep(30)
  }
  expect(opened(player)).toBeGreaterThanOrEqual(2)
})

test('after Geyser starts over, no player is made until it answers, and a returning one gets in', async () => {
  const { player, port, relay, sources, state } = await relayed({ pongRefreshMs: 50 }, true)
  await Bun.sleep(100)
  player.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(50)
  expect(opened(player)).toBe(1)

  // Geyser exits, and is seen to after it last answered: the one that starts next knows nobody
  // and isn't listening yet.
  state.down = true
  sources.clear()
  await Bun.sleep(30)
  relay.forget()
  expect(relay.ready()).toBe(false)
  expect(relay.players()).toBe(0)
  player.socket.send(ping(1), port, '127.0.0.1')
  player.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(100)
  // No pong from the Geyser that is gone, and no player whose header would be lost.
  expect(player.heard.filter((h) => h.bytes[0] === 0x1c)).toHaveLength(0)
  expect(relay.players()).toBe(0)

  state.down = false
  await Bun.sleep(200)
  expect(relay.ready()).toBe(true)
  player.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(50)
  expect(opened(player)).toBe(2)
})

test('it is ready only while Geyser answers', async () => {
  const { relay } = await relayed()
  await Bun.sleep(100)
  expect(relay.ready()).toBe(true)
})

test('it stays ready while Geyser, which takes a header once per source, keeps answering', async () => {
  const { relay } = await relayed({ pongRefreshMs: 50 }, true)
  // Past the time a first pong stays fresh, several times over.
  await Bun.sleep(600)
  expect(relay.ready()).toBe(true)
})

test('it is ready again after Geyser starts over and has forgotten every source', async () => {
  const { relay, geyser, sources } = await relayed({ pongRefreshMs: 50 }, true)
  await Bun.sleep(200)
  expect(relay.ready()).toBe(true)
  sources.clear()
  await Bun.sleep(600)
  expect(relay.ready()).toBe(true)
  expect(geyser.heard.length).toBeGreaterThan(2)
})

test('a probe that cannot be made is said once, is no rejection, and reads as Geyser down', async () => {
  const { relay } = await relayed({ pongRefreshMs: 50 })
  await Bun.sleep(100)
  expect(relay.ready()).toBe(true)
  const real = Bun.udpSocket
  const said: unknown[][] = []
  const log = console.error
  console.error = (...parts: unknown[]) => said.push(parts)
  Bun.udpSocket = (() => Promise.reject(new Error('no sockets left'))) as typeof Bun.udpSocket
  try {
    // Several asks go by, and the last pong ages out.
    await Bun.sleep(500)
    expect(relay.ready()).toBe(false)
    expect(said).toHaveLength(1)
    expect(String(said[0]?.[0])).toContain('could not ask Geyser')
  } finally {
    Bun.udpSocket = real
    console.error = log
  }
})

test('pings are told from other packets, and a pong takes the time of the ping it answers', () => {
  expect(isPing(ping(1))).toBe(true)
  expect(isPing(openRequest())).toBe(false)
  expect(isPing(ping(1).subarray(0, 20))).toBe(false)
  const answer = pongFor(pong('x'), ping(99))
  expect(Array.from(answer.subarray(1, 9))).toEqual(Array.from(ping(99).subarray(1, 9)))
})

test('Geyser’s port closing under it does not take the agent down', async () => {
  const { player, geyser, port, relay } = await relayed()
  await Bun.sleep(100)
  player.socket.send(openRequest(), port, '127.0.0.1')
  await Bun.sleep(100)
  geyser.socket.close()
  // Datagrams to a closed port come back refused; none of it may throw out of the relay.
  for (let i = 0; i < 5; i++) {
    player.socket.send(Uint8Array.of(0x84, i), port, '127.0.0.1')
    await Bun.sleep(30)
  }
  await Bun.sleep(200)
  expect(relay.players()).toBe(1)
})

test('pongs are sent in all only so fast, however many addresses ask', async () => {
  const { port } = await relayed()
  await Bun.sleep(100)
  // Each address is within its own limit; together they are past the total of three.
  const askers = await Promise.all([2, 3, 4, 5, 6].map((n) => listener(undefined, `127.0.0.${n}`)))
  closers.push(...askers.map((a) => () => a.socket.close()))
  for (const asker of askers) asker.socket.send(ping(1), port, '127.0.0.1')
  await Bun.sleep(150)
  expect(askers.reduce((sum, a) => sum + a.heard.length, 0)).toBe(3)
})
