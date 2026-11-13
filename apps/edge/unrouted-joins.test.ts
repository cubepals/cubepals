// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Joins to an address the edge holds no route for yet, as a server created moments ago, are all
 * held in the waiting room, not only the first. mc-router asks the wake webhook for one join of a
 * route at a time, and counts that join as asking until its connection closes; a join that came
 * meanwhile went to the default route's backend, which was none, and was closed at once with
 * nothing said, for as long as the first player stayed.
 *
 * Runs the agent itself, with a real mc-router, against a stand-in control plane that holds no
 * route for the address and whose wake takes a while, and a stand-in game server.
 */

import { afterAll, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { packet, string, varInt } from './notice.ts'
import { ping, ROUTER_BIN } from './router-under-test.ts'

const AGENT = join(import.meta.dir, 'agent.ts')
const ADDRESS = 'new-world.play.example'

const handshake = packet(0, [...varInt(767), ...string(ADDRESS), 0x63, 0xdd, 2])
const login = (name: string) => packet(0, [...string(name), ...new Array(16).fill(0)])

/** A port nothing listens on just now. */
async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Connects to `port` once something listens there. */
async function dial(port: number): Promise<Socket> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const socket = await new Promise<Socket | null>((resolve) => {
      const s = connect(port, '127.0.0.1')
      s.once('connect', () => resolve(s))
      s.once('error', () => resolve(null))
    })
    if (socket !== null) return socket
    if (Date.now() >= deadline) throw new Error(`nothing listened on ${port}`)
    await Bun.sleep(100)
  }
}

/** The names whose logins reached the game server. */
const reached = new Set<string>()
const game = createServer((socket) => {
  let received = Buffer.alloc(0)
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    received = Buffer.concat([received, chunk])
    for (const name of ['Player0', 'Player1']) if (received.includes(Buffer.from(name))) reached.add(name)
  })
})
let up = false
const control = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    // No route yet: the server was created after this edge's last poll, or is still being made.
    if (path.endsWith('/routes')) return Response.json({ routes: [] })
    if (!path.endsWith('/wake')) return new Response(null, { status: 404 })
    await Bun.sleep(200)
    const { port } = game.address() as AddressInfo
    return Response.json(
      up ? { outcome: 'ready', destination: `127.0.0.1:${port}` } : { outcome: 'starting' },
    )
  },
})
let agent: ReturnType<typeof Bun.spawn> | undefined

afterAll(async () => {
  agent?.kill('SIGKILL')
  await agent?.exited
  game.close()
  await control.stop(true)
})

test.skipIf(ROUTER_BIN === '')(
  'a join that comes while another to the same unrouted address waits is held too',
  async () => {
    await new Promise((resolve) => game.listen(0, '127.0.0.1', () => resolve(null)))
    const [sleeping, waiting, agentPort, notice, minecraft, router, routerApi] = await Promise.all(
      Array.from({ length: 7 }, freePort),
    )
    agent = Bun.spawn(['bun', AGENT], {
      env: {
        ...process.env,
        CONTROL_URL: `http://127.0.0.1:${control.port}`,
        EDGE_TOKEN: 'edge',
        EDGE_ID: 'test-edge',
        SLEEPING_PORT: String(sleeping),
        WAITING_PORT: String(waiting),
        AGENT_PORT: String(agentPort),
        NOTICE_PORT: String(notice),
        MINECRAFT_PORT: String(minecraft),
        ROUTER_PORT: String(router),
        ROUTER_API_PORT: String(routerApi),
        ROUTER_BIN,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const joinAs = async (name: string) => {
      const client = await dial(minecraft ?? 0)
      const said = { bytes: 0, closed: false }
      client.on('data', (chunk) => {
        said.bytes += chunk.length
      })
      client.on('error', () => {})
      client.once('close', () => {
        said.closed = true
      })
      client.write(Buffer.concat([handshake, login(name)]))
      return { client, said }
    }
    // A server list's ping at such an address is answered by nothing, as before.
    await dial(minecraft ?? 0).then((socket) => socket.destroy())
    expect(await ping(minecraft ?? 0, ADDRESS)).toBe('closed')

    const first = await joinAs('Player0')
    // The first is in the waiting room, which mc-router counts as its wake for as long as it stays.
    await Bun.sleep(1_500)
    expect(first.said.closed).toBe(false)

    const second = await joinAs('Player1')
    await Bun.sleep(1_500)
    // Held as well: not closed with nothing said.
    expect(second.said).toEqual({ bytes: 0, closed: false })

    up = true
    const deadline = Date.now() + 10_000
    while (reached.size < 2 && Date.now() < deadline) await Bun.sleep(50)
    expect([...reached].sort()).toEqual(['Player0', 'Player1'])
    first.client.destroy()
    second.client.destroy()
  },
  40_000,
)
