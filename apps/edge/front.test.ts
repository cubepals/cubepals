// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The front door: what it reads off a connection, and what it lets through to a stand-in mc-router. */

import { afterEach, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Server } from 'node:net'
import { proxyHeader, readProxyHeader } from '../../packages/contracts/src/proxy-header.ts'
import { front, geyserDoor, readHandshake, readProxyLine } from './front.ts'
import { turnAway } from './hold.ts'
import { Gate, type Limits } from './limits.ts'
import { packet, statusRequest, string, varInt } from './notice.ts'

const encode = (text: string) => new TextEncoder().encode(text)

/** A join's first bytes: the handshake and the start of login. */
function joinRequest(address: string, protocol = 767): Uint8Array {
  const handshake = packet(0, [...varInt(protocol), ...string(address), 0x63, 0xdd, 2])
  return Uint8Array.from([...handshake, ...packet(0, string('Alex'))])
}

test('a PROXY line gives the client, and where the rest begins', () => {
  const bytes = encode('PROXY TCP4 203.0.113.7 10.0.0.1 51234 25565\r\nrest')
  expect(readProxyLine(bytes)).toEqual({ source: { address: '203.0.113.7', port: 51234 }, next: 45 })
  expect(readProxyLine(encode('PROXY UNKNOWN\r\n'))).toEqual({ source: null, next: 15 })
  expect(readProxyLine(encode('PROXY TCP6 2001:db8::1'))).toBe('more')
  expect(readProxyLine(encode('GET / HTTP/1.1\r\n'))).toBe('bad')
})

test('a handshake gives the hostname as routes name it, and whether it is a join', () => {
  expect(readHandshake(statusRequest('Lobby.Play.Test.', 25565))).toEqual({
    hostname: 'lobby.play.test',
    protocol: 767,
    joining: false,
  })
  expect(readHandshake(joinRequest('lobby.play.test\0FML3\0'))).toEqual({
    hostname: 'lobby.play.test',
    protocol: 767,
    joining: true,
  })
  expect(readHandshake(joinRequest('lobby.play.test').subarray(0, 8))).toBe('more')
  expect(readHandshake(Uint8Array.from([0xfe, 0x01]))).toEqual({ hostname: '', protocol: -1, joining: false })
  expect(readHandshake(encode('GET / HTTP/1.1\r\n'))).toBe('bad')
})

const open: Server[] = []
afterEach(() => {
  for (const server of open.splice(0)) server.close()
})

const listening = (server: Server) =>
  new Promise<number>((resolve) =>
    server.once('listening', () => resolve((server.address() as AddressInfo).port)),
  )

/** A stand-in for mc-router: records what each connection sent it. */
async function router(): Promise<{ port: number; received: string[] }> {
  const received: string[] = []
  const server = createServer((socket) => {
    let got = ''
    socket.on('data', (chunk) => {
      got += chunk.toString('latin1')
    })
    socket.on('close', () => received.push(got))
    socket.on('error', () => undefined)
  }).listen(0, '127.0.0.1')
  open.push(server)
  return { port: await listening(server), received }
}

/** Sends `bytes` to the front door, and resolves with all it answered once it closes. */
function dial(port: number, bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(bytes))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => resolve(new Uint8Array(Buffer.concat(chunks))))
    setTimeout(() => socket.end(), 200)
  })
}

/** Whether the door closes a connection that sends `bytes` on its own, within a second. */
function closedByDoor(port: number, bytes: Uint8Array): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(bytes))
    socket.on('error', () => undefined)
    socket.on('close', () => resolve(true))
    setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 1000)
  })
}

async function frontDoor(limits: Limits, proxied: boolean, timeouts = { connectMs: 1_000, idleMs: 60_000 }) {
  const behind = await router()
  const options = {
    port: 0,
    router: behind.port,
    proxied,
    gate: new Gate(limits),
    known: (hostname: string) => hostname.endsWith('.play.test'),
    plain: (hostname: string) => hostname === 'vanilla.play.test',
    busy: 'Busy',
    // The arcade takes 26.2's clients alone.
    refuse: (hostname: string, protocol: number) =>
      hostname === 'arcade.play.test' && protocol !== 776 ? 'Wrong game' : null,
    timeouts,
  }
  const listener = front(options)
  open.push(listener)
  return { port: await listening(listener), behind, options }
}

const ROOMY: Limits = {
  address: { connections: { perSecond: 100, burst: 100 }, greeting: 100 },
  server: { connections: { perSecond: 100, burst: 100 }, open: 100 },
}

test('what the gate lets in reaches mc-router as it came, after a PROXY header naming the client', async () => {
  const { port, behind } = await frontDoor(ROOMY, true)
  const join = joinRequest('a.play.test')
  await dial(port, Uint8Array.from([...encode('PROXY TCP4 203.0.113.7 10.0.0.1 51234 25565\r\n'), ...join]))
  await Bun.sleep(50)
  const received = new Uint8Array(Buffer.from(behind.received[0] ?? '', 'latin1'))
  const header = readProxyHeader(received)
  expect(header).toEqual({ source: { address: '203.0.113.7', port: 51234 }, next: 28 })
  expect(Array.from(received.subarray(28))).toEqual(Array.from(join))
})

test('a join Geyser makes for a Bedrock player is the player’s, and keeps the bytes Floodgate added', async () => {
  const { options, behind } = await frontDoor(ROOMY, true)
  const door = await geyserDoor(options)
  open.push(door.server)
  // Geyser connects at its own door with a v2 header naming the Bedrock player, and writes their
  // Floodgate data after the hostname.
  const join = joinRequest('a.play.test\0floodgate-bytes')
  const header = proxyHeader({ address: '198.51.100.9', port: 40000 }, { address: '127.0.0.1', port: 25565 })
  await dial(door.port, Uint8Array.from([...header, ...join]))
  await Bun.sleep(50)
  const received = new Uint8Array(Buffer.from(behind.received[0] ?? '', 'latin1'))
  const forwarded = readProxyHeader(received)
  expect(forwarded).toMatchObject({ source: { address: '198.51.100.9', port: 40000 } })
  expect(Array.from(received.subarray(typeof forwarded === 'object' ? forwarded.next : 0))).toEqual(
    Array.from(join),
  )
})

test('a Java client that forges Floodgate or forwarded data reaches the server without it', async () => {
  const { port, behind } = await frontDoor(ROOMY, true)
  const line = 'PROXY TCP4 203.0.113.7 10.0.0.1 51234 25565\r\n'
  const forged = [
    'a.play.test\0^Floodgate^forged-bedrock-identity',
    'a.play.test\x00203.0.113.99\x00069a79f444e94726a5befca90e38aaf5\0[{"name":"textures"}]',
  ]
  for (const address of forged) await dial(port, Uint8Array.from([...encode(line), ...joinRequest(address)]))
  // Even from this machine, and with a v2 header of its own: only Geyser's door believes one, so
  // the public door closes the connection itself, before mc-router is dialled.
  const header = proxyHeader({ address: '198.51.100.9', port: 40000 }, { address: '127.0.0.1', port: 25565 })
  const refused = await closedByDoor(
    port,
    Uint8Array.from([...encode(line), ...header, ...joinRequest(forged[0] ?? '')]),
  )
  await Bun.sleep(100)
  const clean = Buffer.from(joinRequest('a.play.test')).toString('latin1')
  for (const got of behind.received.slice(0, 2)) {
    expect(got.endsWith(clean)).toBe(true)
    expect(got).not.toContain('Floodgate')
    expect(got).not.toContain('203.0.113.99')
  }
  expect(refused).toBe(true)
  expect(behind.received).toHaveLength(2)
})

test('a Forge client’s marker is kept, and the packets after the handshake are untouched', async () => {
  const { port, behind } = await frontDoor(ROOMY, true)
  const forge = joinRequest('a.play.test\0FML3\0')
  await dial(port, Uint8Array.from([...encode('PROXY TCP4 203.0.113.7 10.0.0.1 51234 25565\r\n'), ...forge]))
  await Bun.sleep(50)
  expect(behind.received[0]?.endsWith(Buffer.from(forge).toString('latin1'))).toBe(true)
})

test('a join from a game the server can’t take is turned away at once, and mc-router never sees it', async () => {
  const { port, behind } = await frontDoor(ROOMY, false)
  expect(await dial(port, joinRequest('arcade.play.test', 774))).toEqual(turnAway('Wrong game'))
  // A ping from that game still goes on, for the server's own answer to say which it runs.
  await dial(port, statusRequest('arcade.play.test', 25565))
  // And a game it takes joins as ever.
  const join = joinRequest('arcade.play.test', 776)
  await dial(port, join)
  await Bun.sleep(50)
  expect(behind.received).toHaveLength(2)
  expect(behind.received[1]?.endsWith(Buffer.from(join).toString('latin1'))).toBe(true)
})

test('a running server that reads no PROXY header gets its connections without one', async () => {
  const { port, behind } = await frontDoor(ROOMY, true)
  const join = joinRequest('vanilla.play.test')
  await dial(
    port,
    Uint8Array.from([...encode('PROXY TCP6 2001:db8::7 2001:db8::1 51234 25565\r\n'), ...join]),
  )
  await dial(
    port,
    Uint8Array.from([...encode('PROXY TCP6 2001:db8::7 2001:db8::1 51235 25565\r\n'), ...join]),
  )
  await Bun.sleep(50)
  expect(behind.received).toEqual([
    Buffer.from(join).toString('latin1'),
    Buffer.from(join).toString('latin1'),
  ])
})

test('an IPv6 client is named in an IPv6 header, and one written in IPv6 form as IPv4', async () => {
  const { port, behind } = await frontDoor(ROOMY, true)
  const join = joinRequest('a.play.test')
  await dial(
    port,
    Uint8Array.from([...encode('PROXY TCP6 2001:db8::7 2001:db8::1 51234 25565\r\n'), ...join]),
  )
  await Bun.sleep(50)
  await dial(port, Uint8Array.from([...encode('PROXY TCP6 ::ffff:203.0.113.7 ::1 51235 25565\r\n'), ...join]))
  await Bun.sleep(50)
  const [six, four] = behind.received.map((got) =>
    readProxyHeader(new Uint8Array(Buffer.from(got, 'latin1'))),
  )
  expect(six).toEqual({ source: { address: '2001:db8:0:0:0:0:0:7', port: 51234 }, next: 52 })
  expect(four).toEqual({ source: { address: '203.0.113.7', port: 51235 }, next: 28 })
})

test('a flooded server turns joins away in words and leaves pings unanswered, while another still gets through', async () => {
  const { port, behind } = await frontDoor(
    { ...ROOMY, server: { connections: { perSecond: 0.001, burst: 1 }, open: 100 } },
    false,
  )
  await dial(port, joinRequest('busy.play.test'))
  expect(await dial(port, joinRequest('busy.play.test'))).toEqual(turnAway('Busy'))
  expect(await dial(port, statusRequest('busy.play.test', 25565))).toEqual(new Uint8Array())
  await dial(port, joinRequest('quiet.play.test'))
  await Bun.sleep(50)
  expect(behind.received).toHaveLength(2)
  expect(behind.received[1]).toContain('quiet.play.test')
})

test('hostnames no server has are counted together, so made-up ones share one limit', async () => {
  const { port, behind } = await frontDoor(
    { ...ROOMY, server: { connections: { perSecond: 0.001, burst: 1 }, open: 100 } },
    false,
  )
  await dial(port, statusRequest('one.example.test', 25565))
  await dial(port, statusRequest('two.example.test', 25565))
  await dial(port, statusRequest('a.play.test', 25565))
  await Bun.sleep(50)
  expect(behind.received).toHaveLength(2)
})

test('a connection with no PROXY line, where one is expected, gets nowhere', async () => {
  const { port, behind } = await frontDoor(ROOMY, true)
  await dial(port, joinRequest('a.play.test'))
  await Bun.sleep(50)
  expect(behind.received).toEqual([])
})

/** Opens a connection that sends `bytes`, then whatever `every` sends at that pace; when it closed. */
function hold(port: number, bytes: Uint8Array, everyMs: number | null): Promise<number> {
  return new Promise((resolve) => {
    const opened = Date.now()
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(bytes))
    const talking =
      everyMs === null ? undefined : setInterval(() => socket.write(Uint8Array.of(1, 0)), everyMs)
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearInterval(talking)
      resolve(Date.now() - opened)
    })
    setTimeout(() => socket.destroy(), 1_500)
  })
}

test('a connection that goes quiet both ways is closed once its idle time is up', async () => {
  const { port } = await frontDoor(ROOMY, false, { connectMs: 1_000, idleMs: 300 })
  expect(await hold(port, joinRequest('a.play.test'), null)).toBeLessThan(1_000)
})

test('a connection still talking, as a keep-alive does, stays open past its idle time', async () => {
  const { port } = await frontDoor(ROOMY, false, { connectMs: 1_000, idleMs: 300 })
  expect(await hold(port, joinRequest('a.play.test'), 100)).toBeGreaterThanOrEqual(1_500)
})

/**
 * A server that never takes a connection: it listens and never accepts, and the one connection
 * its queue holds is taken already, so the next one's handshake goes unanswered.
 */
async function neverTaking(): Promise<{ port: number; stop: () => void }> {
  const listener = Bun.spawn(
    [
      'python3',
      '-c',
      'import socket,time\ns=socket.socket()\ns.bind(("127.0.0.1",0))\ns.listen(0)\nprint(s.getsockname()[1],flush=True)\ntime.sleep(60)',
    ],
    { stdout: 'pipe' },
  )
  const reader = listener.stdout.getReader()
  const port = Number(new TextDecoder().decode((await reader.read()).value).trim())
  const first = connect({ host: '127.0.0.1', port })
  first.on('error', () => undefined)
  await new Promise((resolve) => first.once('connect', resolve))
  return {
    port,
    stop: () => {
      first.destroy()
      listener.kill()
    },
  }
}

test('a server that never takes the connection is given up on once its connect time is up', async () => {
  const server = await neverTaking()
  try {
    const listener = front({
      port: 0,
      router: server.port,
      proxied: false,
      gate: new Gate(ROOMY),
      known: () => true,
      plain: () => true,
      busy: 'Busy',
      refuse: () => null,
      timeouts: { connectMs: 300, idleMs: 60_000 },
    })
    open.push(listener)
    expect(await hold(await listening(listener), joinRequest('a.play.test'), null)).toBeLessThan(1_000)
  } finally {
    server.stop()
  }
})
