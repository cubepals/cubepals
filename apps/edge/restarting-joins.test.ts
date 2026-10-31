// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A join that reaches a restarting server's notice (mc-router dials its route while another join's
 * wake is asked, or a server stopped answering) waits in the waiting room and is let in once the
 * server is back, rather than being turned away to join again. A ping is still told it restarts.
 *
 * Runs the agent itself against a stand-in control plane, which answers `restarting` for a while,
 * and a stand-in game server that counts what reaches it.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { packet, string, varInt } from './notice.ts'

const AGENT = join(import.meta.dir, 'agent.ts')
const ADDRESS = 'castle.play.example'
const RESTART_MS = 2_500

const handshake = (intent: 1 | 2) => packet(0, [...varInt(767), ...string(ADDRESS), 0x63, 0xdd, intent])
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
    if (Date.now() >= deadline) throw new Error('the restarting notice never listened')
    await Bun.sleep(100)
  }
}

describe('a join while its server restarts', () => {
  const reached: string[] = []
  const started = Date.now()
  let wakes = 0
  const game = createServer((socket) => {
    socket.on('data', (chunk) => {
      const name = Buffer.from(chunk)
        .toString('latin1')
        .match(/Player\d/)?.[0]
      if (name) reached.push(name)
    })
    socket.on('error', () => {})
  })
  const control = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith('/routes'))
        return Response.json({
          routes: [{ hostname: ADDRESS, destination: '127.0.0.1:1', state: 'restarting' }],
        })
      if (!path.endsWith('/wake')) return new Response(null, { status: 404 })
      wakes++
      if (Date.now() - started < RESTART_MS) return Response.json({ outcome: 'restarting' })
      const { port } = game.address() as AddressInfo
      return Response.json({ outcome: 'ready', destination: `127.0.0.1:${port}` })
    },
  })
  let agent: ReturnType<typeof Bun.spawn> | undefined
  let notice = 0

  afterAll(async () => {
    agent?.kill('SIGKILL')
    await agent?.exited
    game.close()
    await control.stop(true)
  })

  test('waits, and is let in once the server is back', async () => {
    await new Promise((resolve) => game.listen(0, '127.0.0.1', () => resolve(null)))
    const ports = await Promise.all(Array.from({ length: 7 }, freePort))
    const [sleeping, waiting, agentPort, noticePort, minecraft, router, routerApi] = ports
    notice = noticePort ?? 0
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
        ROUTER_BIN: 'true',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const client = await dial(notice)
    const closed = new Promise((resolve) => client.once('close', resolve))
    client.write(Buffer.concat([handshake(2), login('Player1')]))

    await Bun.sleep(RESTART_MS / 2)
    // Held while it restarts: not turned away, and nothing has reached the server yet.
    expect(client.destroyed).toBe(false)
    expect(reached).toEqual([])

    const deadline = Date.now() + 15_000
    while (reached.length === 0 && Date.now() < deadline) await Bun.sleep(50)
    expect(reached).toEqual(['Player1'])
    expect(wakes).toBeGreaterThan(1)
    client.destroy()
    await closed
  }, 30_000)

  test('a ping is told it restarts', async () => {
    const client = await dial(notice)
    const answer = new Promise<string>((resolve) => {
      let text = ''
      client.on('data', (chunk) => {
        text += Buffer.from(chunk).toString('utf8')
        if (text.includes('Restarting')) resolve(text)
      })
    })
    client.write(Buffer.concat([handshake(1), packet(0, [])]))
    expect(await answer).toContain('Restarting · back in a moment')
    client.destroy()
  }, 15_000)
})
