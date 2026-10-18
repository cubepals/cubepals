// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Joins that arrive together at a sleeping server are all held, share the one wake, and are let in
 * when it is up. mc-router wakes once and dials the route of a join that arrives meanwhile, which
 * leads to the sleeping notice: that join must wait like the first, not be passed on to a server
 * that isn't up.
 *
 * Runs the agent itself against a stand-in control plane, whose wake takes a while, and a stand-in
 * game server that counts what reaches it.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { packet, string, varInt } from './notice.ts'

const AGENT = join(import.meta.dir, 'agent.ts')
const ADDRESS = 'castle.play.example'
const WAKE_MS = 1_500

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

describe.each([2, 3])('%d joins to a sleeping server within a few milliseconds', (count) => {
  const wakes: number[] = []
  const reached: { at: number; name: string }[] = []
  const started = Date.now()
  const game = createServer((socket) => {
    socket.on('data', (chunk) => {
      const name = Buffer.from(chunk)
        .toString('latin1')
        .match(/Player\d/)?.[0]
      if (name) reached.push({ at: Date.now() - started, name })
    })
    socket.on('error', () => {})
  })
  const control = Bun.serve({
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith('/wake')) return new Response(null, { status: 404 })
      wakes.push(Date.now() - started)
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

  test('all are held for the one wake, then let in', async () => {
    await new Promise((resolve) => game.listen(0, '127.0.0.1', () => resolve(null)))
    const [sleeping, ...others] = await Promise.all(Array.from({ length: 7 }, freePort))
    const [waiting, agentPort, notice, minecraft, router, routerApi] = others
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
    // Connected first, so the joins are sent within a few milliseconds of each other.
    const clients = await Promise.all(Array.from({ length: count }, () => dial(sleeping ?? 0)))
    const closed = clients.map((c) => new Promise<boolean>((resolve) => c.once('close', () => resolve(true))))
    const sent = Date.now()
    for (const [i, client] of clients.entries()) client.write(Buffer.concat([handshake, login(`Player${i}`)]))

    await Bun.sleep(WAKE_MS / 2)
    // Held while the server wakes: nothing has reached it, and nobody has been dropped.
    expect(reached).toEqual([])
    expect(clients.every((c) => !c.destroyed)).toBe(true)

    const deadline = Date.now() + 10_000
    while (reached.length < count && Date.now() < deadline) await Bun.sleep(50)
    expect(reached.map((r) => r.name).sort()).toEqual(clients.map((_, i) => `Player${i}`))
    // Not before the wake was over, and all of them on the one wake.
    expect(Math.min(...reached.map((r) => r.at)) - (sent - started)).toBeGreaterThanOrEqual(WAKE_MS - 100)
    expect(wakes).toHaveLength(1)
    for (const client of clients) client.destroy()
    await Promise.all(closed)
  }, 30_000)
})
