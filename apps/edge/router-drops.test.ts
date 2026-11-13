// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A join mc-router closes with nothing said, because it could connect it to no backend, is
 * recorded as a join that reached no server, with mc-router's own word for why. It was recorded
 * as handed straight to a running server, so a drop read like a join that got in.
 *
 * Runs the agent itself, with a real mc-router, against a stand-in control plane that keeps the
 * visits the agent reports. mc-router asks the wake webhook for one join of a route at a time and
 * dials the route for a join that comes meanwhile: here that route leads to a server that is gone,
 * and then, with mc-router's default route emptied through its API, to nothing at all.
 */

import { afterAll, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { VisitReport } from '../../packages/contracts/src/join-records.ts'
import { packet, string, varInt } from './notice.ts'
import { ROUTER_STATUS } from './router-session.ts'
import { answering, ROUTER_BIN } from './router-under-test.ts'

const AGENT = join(import.meta.dir, 'agent.ts')
/** A server that runs and answers; one whose route says it runs, at a port nothing listens on; no server. */
const [LIVE, GONE, UNROUTED] = ['live.play.example', 'gone.play.example', 'nobody.play.example']

const handshake = (address: string) => packet(0, [...varInt(767), ...string(address), 0x63, 0xdd, 2])
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

const servers: Server[] = []
/** Every visit the agent reported, in the order it came. */
const reported: VisitReport[] = []
let live = ''
let gone = ''
const control = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path.endsWith('/routes'))
      return Response.json({
        routes: [
          { hostname: LIVE, destination: live },
          { hostname: GONE, destination: gone },
        ],
      })
    if (path.endsWith('/visits')) {
      reported.push(...((await request.json()) as { reports: VisitReport[] }).reports)
      return new Response(null, { status: 204 })
    }
    if (!path.endsWith('/wake')) return new Response(null, { status: 404 })
    const { hostname } = (await request.json()) as { hostname: string }
    // The live server is up; every other is said to be starting, for as long as the test runs.
    return Response.json(
      hostname === LIVE ? { outcome: 'ready', destination: live } : { outcome: 'starting' },
    )
  },
})
let agent: ReturnType<typeof Bun.spawn> | undefined

afterAll(async () => {
  agent?.kill('SIGKILL')
  await agent?.exited
  for (const server of servers) server.close()
  await control.stop(true)
})

/** The halves the agent reported of the join `name` made, once both have come. */
async function visitOf(name: string): Promise<Partial<Record<VisitReport['phase'], VisitReport>>> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const halves = Object.fromEntries(
      reported.filter((report) => report.player?.name === name).map((report) => [report.phase, report]),
    )
    if ((halves.open && halves.close) || Date.now() >= deadline) return halves
    await Bun.sleep(50)
  }
}

test.skipIf(ROUTER_BIN === '')(
  'a join mc-router could connect to no backend is recorded as reaching no server, with its status',
  async () => {
    live = await answering('Live', servers)
    gone = `127.0.0.1:${await freePort()}`
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
        // A visit's second half comes this long after its connection closes.
        VISIT_LINGER_MS: '200',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const joinAs = async (name: string, address: string) => {
      const client = await dial(minecraft ?? 0)
      const said = { bytes: 0, closed: false }
      client.on('data', (chunk) => {
        said.bytes += chunk.length
      })
      client.on('error', () => {})
      client.once('close', () => {
        said.closed = true
      })
      client.write(Buffer.concat([handshake(address), login(name)]))
      return { client, said }
    }

    // A join mc-router connects to its server is handed over, as before.
    await joinAs('Arrived', LIVE)
    const arrived = await visitOf('Arrived')
    expect(arrived.open?.path).toBe('direct')
    expect(arrived.open?.handedAt).toBeString()
    expect(arrived.close?.leftReason).toBeUndefined()

    // The first join to a server that is said to run and isn't up waits in the waiting room, which
    // mc-router counts as its wake for as long as it stays; the next is dialled to the route.
    const first = await joinAs('Waiting', GONE)
    await Bun.sleep(1_500)
    expect(first.said.closed).toBe(false)
    const unreachable = await joinAs('Unreached', GONE)
    const unreached = await visitOf('Unreached')
    // The player is told nothing, as before: the record is what says so now.
    expect(unreachable.said).toEqual({ bytes: 0, closed: true })
    const failed = `refused:${ROUTER_STATUS.failedBackendConnection}`
    expect(unreached.open).toMatchObject({ path: 'refused', leftReason: failed })
    expect(unreached.open?.handedAt).toBeUndefined()
    expect(unreached.close).toMatchObject({ path: 'refused', leftReason: failed, bytesDown: 0 })
    expect(unreached.close?.handedAt).toBeUndefined()

    // With no backend on mc-router's default route, a join to an address it holds no route for
    // that comes while another waits has nowhere to go at all.
    const emptied = await fetch(`http://127.0.0.1:${routerApi}/defaultRoute`, {
      method: 'POST',
      body: JSON.stringify({ backend: '' }),
    })
    expect(emptied.ok).toBe(true)
    const second = await joinAs('Asking', UNROUTED)
    await Bun.sleep(1_500)
    expect(second.said.closed).toBe(false)
    const nowhere = await joinAs('Unrouted', UNROUTED)
    const unrouted = await visitOf('Unrouted')
    expect(nowhere.said).toEqual({ bytes: 0, closed: true })
    const missing = `refused:${ROUTER_STATUS.missingBackend}`
    expect(unrouted.open).toMatchObject({ path: 'refused', leftReason: missing })
    expect(unrouted.open?.handedAt).toBeUndefined()
    expect(unrouted.close).toMatchObject({ path: 'refused', leftReason: missing, bytesDown: 0 })
    first.client.destroy()
    second.client.destroy()
  },
  60_000,
)
