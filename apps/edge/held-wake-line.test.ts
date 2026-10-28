// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server-list ping to a server whose wake a join here waits on says it is waking, though its
 * route still says only that it sleeps: a join that came while the server was still going to
 * sleep waits for that before the control plane starts it, and only then does the route say so.
 *
 * Runs the agent itself against a stand-in control plane, whose route says the server sleeps and
 * whose wake takes a while, and a stand-in game server.
 */

import { afterAll, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { packet, readVarInt, statusRequest, string, varInt } from './notice.ts'

const AGENT = join(import.meta.dir, 'agent.ts')
const ADDRESS = 'castle.play.example'
const WAKE_MS = 4_000

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
    if (Date.now() >= deadline) throw new Error('the sleeping notice never listened')
    await Bun.sleep(100)
  }
}

/** A chat component's text, as the server list shows it. */
const textOf = (component: unknown): string =>
  typeof component === 'string'
    ? component
    : component !== null && typeof component === 'object'
      ? String((component as { text?: unknown }).text ?? '') +
        ((component as { extra?: unknown[] }).extra ?? []).map(textOf).join('')
      : ''

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
        const length = readVarInt(received, 0)
        if (length === null || received.length < length.next + length.value) return
        const id = readVarInt(received, length.next)
        const size = id === null ? null : readVarInt(received, id.next)
        if (size === null) return
        clearTimeout(timer)
        const answer = JSON.parse(received.subarray(size.next, size.next + size.value).toString('utf8'))
        resolve(textOf(answer.description))
      })
    })
  } finally {
    socket.destroy()
  }
}

const game = createServer((socket) => socket.on('error', () => {}))
let wakes = 0
const control = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path.endsWith('/routes'))
      return Response.json({ routes: [{ hostname: ADDRESS, destination: '0.0.0.0:0', state: 'asleep' }] })
    if (!path.endsWith('/wake')) return new Response(null, { status: 404 })
    wakes++
    await Bun.sleep(WAKE_MS)
    const { port } = game.address() as AddressInfo
    return Response.json({ outcome: 'ready', destination: `127.0.0.1:${port}` })
  },
})
let agent: ReturnType<typeof Bun.spawn> | undefined

afterAll(async () => {
  agent?.kill('SIGKILL')
  await agent?.exited
  game.close()
  await control.stop(true)
})

test('a ping says the server wakes while a join here waits on its wake', async () => {
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
      // No mc-router: the sleeping notice listens before the agent waits on it.
      ROUTER_BIN: 'true',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const port = sleeping ?? 0
  // Asleep, and nobody waking it.
  expect(await listLine(port)).toBe('Sleeping · join to wake it up')

  const client = await dial(port)
  client.write(Buffer.concat([handshake, login('Player0')]))
  const deadline = Date.now() + 5_000
  while (wakes === 0 && Date.now() < deadline) await Bun.sleep(50)
  expect(wakes).toBe(1)
  // Held while the control plane waits to start it: its route still says only that it sleeps.
  expect(await listLine(port)).toBe('Waking your world')
  client.destroy()
}, 30_000)
