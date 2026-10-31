// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Joins to a server restarting for its owner's change are held until it is back, every one of
 * them, not only the one mc-router asked the wake webhook about. mc-router dials the route for
 * joins that arrive while it asks, and the route led to the restarting notice, which turned each
 * away at once to join again: in production players did, a dozen times in a few seconds.
 *
 * Runs the agent itself against a stand-in control plane, whose route says the server restarts
 * until it is back, a stand-in for mc-router's API, which keeps the routes the agent sets, and a
 * stand-in game server.
 */

import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packet, readVarInt, statusRequest, string, varInt } from './notice.ts'
import { RESTARTING } from './waking-line.ts'

const AGENT = join(import.meta.dir, 'agent.ts')
const ADDRESS = 'castle.play.example'
/** How long the server stays down once the joins are in. */
const DOWN_MS = 3_000

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
  const deadline = Date.now() + 10_000
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

/** The text a server-list answer or a login disconnect carries, from its first packet. */
function textIn(received: Buffer): string | null {
  const length = readVarInt(received, 0)
  if (length === null || received.length < length.next + length.value) return null
  const id = readVarInt(received, length.next)
  const size = id === null ? null : readVarInt(received, id.next)
  if (size === null) return null
  const json = JSON.parse(received.subarray(size.next, size.next + size.value).toString('utf8'))
  const component = json.description ?? json
  return typeof component === 'string' ? component : String(component.text ?? '')
}

/** The line a server-list ping to `port` reads. */
async function listLine(port: number): Promise<string> {
  const socket = await dial(port)
  socket.write(statusRequest(ADDRESS, 25565))
  let received = Buffer.alloc(0)
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the ping had no answer')), 5_000)
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk])
        const text = textIn(received)
        if (text === null) return
        clearTimeout(timer)
        resolve(text)
      })
    })
  } finally {
    socket.destroy()
  }
}

/** What each connection the game server took was sent first, by the name in its login. */
const reached = new Map<string, string>()
const game = createServer((socket) => {
  let received = Buffer.alloc(0)
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    received = Buffer.concat([received, chunk])
    for (const name of ['Player0', 'Player1'])
      if (received.includes(Buffer.from(name))) reached.set(name, 'in')
  })
})
let back = false
const control = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    const { port } = game.address() as AddressInfo
    const destination = `127.0.0.1:${port}`
    if (path.endsWith('/routes'))
      return Response.json({
        routes: [{ hostname: ADDRESS, destination, ...(back ? {} : { state: 'restarting' }) }],
      })
    if (!path.endsWith('/wake')) return new Response(null, { status: 404 })
    return Response.json(back ? { outcome: 'ready', destination } : { outcome: 'restarting' })
  },
})
/** mc-router's routes, as the agent set them through its API. */
const routed = new Map<string, string>()
const routerApi = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path === '/routes') {
      const body = (await request.json()) as { serverAddress: string; backend: string }
      routed.set(body.serverAddress, body.backend)
    }
    return path === '/routes' && request.method === 'GET' ? Response.json([]) : new Response(null)
  },
})
const scratch = mkdtempSync(join(tmpdir(), 'held-restart-'))
let agent: ReturnType<typeof Bun.spawn> | undefined

afterAll(async () => {
  agent?.kill('SIGKILL')
  await agent?.exited
  game.close()
  await control.stop(true)
  await routerApi.stop(true)
  rmSync(scratch, { recursive: true, force: true })
})

test('every join to a restarting server is held until it is back, then let in', async () => {
  await new Promise((resolve) => game.listen(0, '127.0.0.1', () => resolve(null)))
  // mc-router itself isn't run: a stand-in that stays up, as the agent supervises it.
  const router = join(scratch, 'mc-router')
  writeFileSync(router, '#!/bin/sh\nexec sleep 600\n')
  chmodSync(router, 0o755)
  const [sleeping, waiting, agentPort, notice, minecraft, routerPort] = await Promise.all(
    Array.from({ length: 6 }, freePort),
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
      ROUTER_PORT: String(routerPort),
      ROUTER_API_PORT: String(routerApi.port),
      ROUTER_BIN: router,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const deadline = Date.now() + 15_000
  while (!routed.has(ADDRESS) && Date.now() < deadline) await Bun.sleep(50)
  // Where mc-router dials the route, for a ping and for a join that came while it asked.
  const route = Number(routed.get(ADDRESS)?.split(':')[1])
  expect(await listLine(route)).toBe(RESTARTING)

  // Two friends join together: one as mc-router hands the join it asked about, one as it dials
  // the route for the join that came while it asked.
  const told: string[] = []
  const clients = await Promise.all(
    [waiting ?? 0, route].map(async (port, i) => {
      const client = await dial(port)
      let received = Buffer.alloc(0)
      client.on('data', (chunk) => {
        received = Buffer.concat([received, chunk])
        const text = textIn(received)
        if (text !== null && text.includes('·')) told.push(text)
      })
      client.on('error', () => {})
      client.write(Buffer.concat([handshake, login(`Player${i}`)]))
      return client
    }),
  )
  await Bun.sleep(DOWN_MS)
  // Still held, and nobody told to come back later.
  expect(told).toEqual([])
  expect(clients.every((client) => !client.destroyed)).toBe(true)
  expect(reached.size).toBe(0)

  back = true
  const inBy = Date.now() + 10_000
  while (reached.size < 2 && Date.now() < inBy) await Bun.sleep(50)
  expect([...reached.keys()].sort()).toEqual(['Player0', 'Player1'])
  expect(told).toEqual([])
  for (const client of clients) client.destroy()
}, 40_000)
