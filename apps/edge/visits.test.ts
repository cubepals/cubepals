// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One visit per connection (`visits.ts`): pings linked to the join after them and the one after a
 * player leaves, looks and how many are sent, and, through the agent itself with a real mc-router
 * in front of stand-in game servers, the halves a join to a running server, a held join and a
 * join to a server that reads no PROXY header each report.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { HOUR_MS } from '../../packages/contracts/src/durations.ts'
import type { VisitReport } from '../../packages/contracts/src/join-records.ts'
import { packet, statusRequest, string, varInt } from './notice.ts'
import { ROUTER_BIN } from './router-under-test.ts'
import { sourceKey, Visits } from './visits.ts'

const TIMES = { lingerMs: 40, lookEveryMs: 1_000, looksPerHour: 2 }
const EDGE = { edgeId: 'edge-1', region: 'fra' }

describe('visits', () => {
  const sent: VisitReport[] = []
  const visits = new Visits((r) => sent.push(r), EDGE, TIMES)
  const settle = () => Bun.sleep(TIMES.lingerMs * 3)

  test('a ping before a join is the join’s, and one after it leaves says it looked again', async () => {
    visits.pinged('203.0.113.1:5000', 'a.play.test')
    const visit = visits.arrived('203.0.113.1:5001', { address: 'a.play.test', protocol: 767 })
    expect(visit.pingedAt).toBeDefined()
    visits.update('203.0.113.1:5001', { path: 'direct', handedAt: new Date().toISOString() })
    visits.open('203.0.113.1:5001')
    visits.open('203.0.113.1:5001')
    visits.closed('203.0.113.1:5001', { up: 10, down: 20 })
    visits.pinged('203.0.113.1:5002', 'a.play.test')
    await settle()
    const mine = sent.filter((r) => r.joinId === visit.joinId)
    expect(mine.map((r) => r.phase)).toEqual(['open', 'close'])
    expect(mine[1]).toMatchObject({ path: 'direct', bytesUp: 10, bytesDown: 20 })
    expect(mine[1]?.pingedAfterAt).toBeDefined()
    // Only the ping after leaving was left without a join of its own.
    expect(sent.filter((r) => r.phase === 'look' && r.address === 'a.play.test')).toHaveLength(1)
  })

  test('a ping alone is a look, one per address a while, so many an hour, the rest counted', async () => {
    for (const port of [1, 2, 3]) visits.pinged(`198.51.100.${port}:7000`, 'b.play.test')
    visits.pinged('198.51.100.1:7001', 'b.play.test')
    await settle()
    visits.pinged('198.51.100.9:7000', 'b.play.test')
    await settle()
    const looks = sent.filter((r) => r.phase === 'look' && r.address === 'b.play.test')
    expect(looks).toHaveLength(2)
    expect(looks[0]).toMatchObject({ source: '198.51.100.1:7000', edgeId: 'edge-1', region: 'fra' })
    expect(looks.every((l) => l.pingedAt === l.connectedAt)).toBe(true)
  })

  test('a join turned away at the door is sent whole, at once', () => {
    visits.refused('192.0.2.7:900', { address: 'c.play.test', protocol: 47 }, 'wrong_game')
    expect(sent.at(-1)).toMatchObject({ phase: 'close', path: 'refused', leftReason: 'refused:wrong_game' })
  })

  test('an address’s hour of looks is let go once it is over, whatever was pinged', async () => {
    let clock = Date.parse('2026-10-20T10:00:00Z')
    const kept = new Visits(
      () => undefined,
      EDGE,
      TIMES,
      () => new Date(clock),
    )
    for (const address of ['a.play.test', 'b.play.test', 'c.play.test']) kept.pinged('192.0.2.1:1', address)
    await settle()
    expect(kept.held()).toEqual({ visits: 0, pings: 0, looks: 3 })
    clock += 2 * HOUR_MS
    kept.pinged('192.0.2.1:2', 'd.play.test')
    await settle()
    expect(kept.held().looks).toBe(1)
  })

  test('an IPv6 source is one key however it is spelt', () => {
    expect(sourceKey('2001:db8:0:0:0:0:0:1', 5)).toBe(sourceKey('2001:DB8::1', 5))
    expect(sourceKey('::ffff:203.0.113.4', 5)).toBe('203.0.113.4:5')
  })
})

// ─── Through the agent, with a real mc-router ─────────────────────────────────────────────────

const AGENT = join(import.meta.dir, 'agent.ts')

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

const handshake = (address: string, intent: number) =>
  packet(0, [...varInt(767), ...string(address), 0x63, 0xdd, intent])
const loginStart = (name: string) => packet(0, [...string(name), ...new Array(16).fill(7)])

/** What the stand-in control plane was sent, and the names the stand-in server heard. */
const reports: VisitReport[] = []
const reached = new Set<string>()
/** The agent's front door. */
let front = 0

/** A player joining `address` as `name`, staying until the server has heard them, then leaving. */
async function joins(address: string, name: string): Promise<void> {
  const socket = await dialled(front)
  socket.on('data', () => undefined)
  socket.write(Buffer.concat([handshake(address, 2), loginStart(name)]))
  const deadline = Date.now() + 10_000
  while (!reached.has(name) && Date.now() < deadline) await Bun.sleep(50)
  expect(reached.has(name)).toBe(true)
  await Bun.sleep(200)
  await closed(socket)
}

/** The halves reported for `name`'s join, once they have come. */
async function halves(name: string): Promise<VisitReport[]> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const open = reports.find((r) => r.phase === 'open' && r.player?.name === name)
    const mine = open === undefined ? [] : reports.filter((r) => r.joinId === open.joinId)
    if (mine.some((r) => r.phase === 'close') || Date.now() > deadline) return mine
    await Bun.sleep(100)
  }
}

const ordered = (...times: (string | undefined)[]) =>
  times.every((t, i) => t !== undefined && (i === 0 || Date.parse(t) >= Date.parse(times[i - 1] ?? '')))

/** A stand-in game server: says a byte back to anything, which is enough to be up. Where it listens. */
async function standInGame(servers: Server[]): Promise<string> {
  const game = createServer((socket) => {
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk) => {
      const named = Buffer.from(chunk)
        .toString('latin1')
        .match(/Visitor\w+/)?.[0]
      if (named) reached.add(named)
      socket.write(Uint8Array.of(1, 0))
    })
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => game.once('listening', resolve))
  servers.push(game)
  return `127.0.0.1:${(game.address() as AddressInfo).port}`
}

describe.skipIf(ROUTER_BIN === '')('the agent’s visits', () => {
  const servers: Server[] = []
  let agent: ReturnType<typeof Bun.spawn> | undefined
  let control: ReturnType<typeof Bun.serve> | undefined

  beforeAll(async () => {
    const destination = await standInGame(servers)
    const routes = [
      { hostname: 'direct.play.test', destination, proxyProtocol: true },
      { hostname: 'looked.play.test', destination, proxyProtocol: true },
      { hostname: 'plain.play.test', destination },
      { hostname: 'held.play.test', destination: '0.0.0.0:0', state: 'asleep' },
    ]
    control = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path.endsWith('/routes')) return Response.json({ routes })
        if (path.endsWith('/visits')) {
          reports.push(...((await request.json()) as { reports: VisitReport[] }).reports)
          return new Response(null, { status: 204 })
        }
        if (path.endsWith('/wake')) {
          const { hostname } = (await request.json()) as { hostname: string }
          if (hostname === 'held.play.test') await Bun.sleep(500)
          const wakeOperationId = '01900000-0000-7000-8000-00000000000a'
          return Response.json({ outcome: 'ready', destination, wakeOperationId })
        }
        return new Response(null, { status: 204 })
      },
    })
    const [waiting, agentPort, notice, sleeping, minecraft, router, routerApi] = await Promise.all(
      Array.from({ length: 7 }, freePort),
    )
    front = minecraft ?? 0
    agent = Bun.spawn(['bun', AGENT], {
      env: {
        ...process.env,
        CONTROL_URL: `http://127.0.0.1:${control.port}`,
        EDGE_TOKEN: 'edge',
        EDGE_ID: 'test-edge',
        FLY_REGION: 'fra',
        VISIT_LINGER_MS: '300',
        WAITING_PORT: String(waiting),
        AGENT_PORT: String(agentPort),
        NOTICE_PORT: String(notice),
        SLEEPING_PORT: String(sleeping),
        MINECRAFT_PORT: String(front),
        ROUTER_PORT: String(router),
        ROUTER_API_PORT: String(routerApi),
        ROUTER_BIN,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const deadline = Date.now() + 15_000
    while (!(await opens(front)) && Date.now() < deadline) await Bun.sleep(200)
  }, 30_000)

  afterAll(async () => {
    agent?.kill('SIGKILL')
    await agent?.exited
    await control?.stop(true)
    for (const server of servers) server.close()
  })

  test('a join to a running server: one open, one close, handed over at once', async () => {
    await joins('direct.play.test', 'VisitorDirect')
    const [open, close, ...rest] = await halves('VisitorDirect')
    expect(rest).toEqual([])
    expect(open).toMatchObject({ phase: 'open', path: 'direct', edgeId: 'test-edge', region: 'fra' })
    expect(close).toMatchObject({ phase: 'close', joinId: open?.joinId, path: 'direct', protocol: 767 })
    expect(ordered(close?.connectedAt, close?.handedAt, close?.leftAt)).toBe(true)
    expect(close?.bytesUp).toBeGreaterThan(0)
    expect(close?.bytesDown).toBeGreaterThan(0)
  }, 20_000)

  test('a join held in the waiting room: woken, then handed over', async () => {
    await joins('held.play.test', 'VisitorHeld')
    const [open, close, ...rest] = await halves('VisitorHeld')
    expect(rest).toEqual([])
    expect(open).toMatchObject({ path: 'held', wakeOperationId: '01900000-0000-7000-8000-00000000000a' })
    expect(
      ordered(close?.connectedAt, close?.wakeAskedAt, close?.readyAt, close?.handedAt, close?.leftAt),
    ).toBe(true)
    expect(close?.bytesDown).toBeGreaterThan(0)
  }, 20_000)

  test('a server that reads no PROXY header still has its joins reported whole', async () => {
    await joins('plain.play.test', 'VisitorPlain')
    const [open, close] = await halves('VisitorPlain')
    expect(open).toMatchObject({ path: 'direct', address: 'plain.play.test' })
    expect(close?.bytesUp).toBeGreaterThan(0)
  }, 20_000)

  test('a ping, then a join; one after leaving; one alone, a look; one at a name nobody has, nothing', async () => {
    await pinged(front, 'direct.play.test')
    await joins('direct.play.test', 'VisitorPinged')
    await pinged(front, 'direct.play.test')
    const [, close] = await halves('VisitorPinged')
    expect(close?.pingedAt).toBeDefined()
    expect(close?.pingedAfterAt).toBeDefined()
    await pinged(front, 'looked.play.test')
    const deadline = Date.now() + 5_000
    while (
      !reports.some((r) => r.phase === 'look' && r.address === 'looked.play.test') &&
      Date.now() < deadline
    )
      await Bun.sleep(100)
    expect(reports.filter((r) => r.phase === 'look' && r.address === 'looked.play.test')).toHaveLength(1)
    await pinged(front, 'nobody-here.play.test')
    await Bun.sleep(1_500)
    expect(reports.filter((r) => r.address === 'nobody-here.play.test')).toEqual([])
  }, 20_000)
})

async function dialled(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1')
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  return socket
}

/** Whether the front door takes a connection yet. */
async function opens(port: number): Promise<boolean> {
  try {
    ;(await dialled(port)).destroy()
    return true
  } catch {
    return false
  }
}

function closed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.once('close', () => resolve())
    socket.end()
    setTimeout(() => socket.destroy(), 500)
  })
}

/** A server list's ping through the front door, answered or not. */
async function pinged(port: number, address: string): Promise<void> {
  const socket = await dialled(port)
  socket.on('data', () => socket.destroy())
  socket.write(statusRequest(address, 25565))
  await new Promise((resolve) => {
    socket.once('close', resolve)
    setTimeout(() => socket.destroy(), 2_000)
  })
}
