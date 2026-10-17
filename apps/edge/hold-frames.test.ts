// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The waiting room refuses a frame whose length is negative, as the front door and the notices do:
 * the connection is let go at once, no server wakes for it, and the edge goes on serving everyone
 * else.
 *
 * `Held` runs on the agent's own event loop, so the construction runs in a child bun and the test
 * asserts it returns before a deadline. The wake is the agent's, so that test runs the agent itself
 * against a stand-in control plane that counts what it is asked.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer } from 'node:net'
import { join } from 'node:path'
import { Held } from './hold.ts'
import { packet, string, varInt } from './notice.ts'

const HOLD = join(import.meta.dir, 'hold.ts')
const NOTICE = join(import.meta.dir, 'notice.ts')
const AGENT = join(import.meta.dir, 'agent.ts')

const ADDRESS = 'anything.play.example'
const handshake = packet(0, [...varInt(767), ...string(ADDRESS), 0x63, 0xdd, 2])
const login = packet(0, [...string('Steve'), ...new Array(16).fill(0)])
/** A frame length that reads as a negative varint. */
const negative = [0xfb, 0xff, 0xff, 0xff, 0x0f]

/** Builds a held join from one chunk; whether `Held`'s constructor returned before `ms`. */
async function construction(ms: number): Promise<boolean> {
  const script = `
    import { Held } from ${JSON.stringify(HOLD)}
    import { packet, string, varInt } from ${JSON.stringify(NOTICE)}
    const handshake = packet(0, [...varInt(767), ...string('${ADDRESS}'), 0x63, 0xdd, 2])
    const login = packet(0, [...string('Steve'), ...new Array(16).fill(0)])
    const negative = Uint8Array.from(${JSON.stringify(negative)})
    new Held({ address: '${ADDRESS}', protocol: 767,
      bytes: Uint8Array.from([...handshake, ...login, ...negative]) })
    console.log('done')
  `
  const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'ignore' })
  const timer = setTimeout(() => child.kill('SIGKILL'), ms)
  const out = await new Response(child.stdout).text()
  await child.exited
  clearTimeout(timer)
  return out.includes('done')
}

/** A port nothing listens on just now. */
async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Sends `bytes` to the waiting room at `port` once it listens; whether it closed within `ms`. */
async function closedWithin(port: number, bytes: Uint8Array, ms: number): Promise<boolean> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const closed = await new Promise<boolean | null>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      let open = false
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, ms + 10_000)
      socket.once('connect', () => {
        open = true
        socket.write(bytes)
        clearTimeout(timer)
        setTimeout(() => {
          socket.destroy()
          resolve(false)
        }, ms)
      })
      socket.once('close', () => resolve(open ? true : null))
      socket.on('error', () => {})
    })
    if (closed !== null) return closed
    if (Date.now() >= deadline) throw new Error('the waiting room never listened')
    await Bun.sleep(100)
  }
}

describe('a negative frame length in the waiting room', () => {
  test('a held join with a negative frame length returns at once', async () => {
    expect(await construction(3_000)).toBe(true)
  }, 10_000)

  test('a join that carries one is refused before anything waits on it', () => {
    const held = new Held({
      address: ADDRESS,
      protocol: 767,
      bytes: Uint8Array.from([...handshake, ...login, ...negative]),
    })
    expect(held.refused).toBe(true)
    expect(held.receive(login)).toBe(false)
  })

  test('one that comes later lets the join go', () => {
    const held = new Held({
      address: ADDRESS,
      protocol: 767,
      bytes: Uint8Array.from([...handshake, ...login]),
    })
    expect(held.refused).toBe(false)
    expect(held.receive(Uint8Array.from(negative))).toBe(false)
    expect(held.refused).toBe(true)
  })

  describe('in the running agent', () => {
    const asked: string[] = []
    const control = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        asked.push(path)
        if (path.endsWith('/wake')) return Response.json({ outcome: 'starting' })
        return new Response(null, { status: 404 })
      },
    })
    let agent: ReturnType<typeof Bun.spawn> | undefined

    afterAll(async () => {
      agent?.kill('SIGKILL')
      await agent?.exited
      await control.stop(true)
    })

    test('the connection is refused at once, and no server wakes for it', async () => {
      const [waiting, ...others] = await Promise.all(Array.from({ length: 7 }, freePort))
      const [agentPort, notice, sleeping, minecraft, router, routerApi] = others
      agent = Bun.spawn(['bun', AGENT], {
        env: {
          ...process.env,
          CONTROL_URL: `http://127.0.0.1:${control.port}`,
          EDGE_TOKEN: 'edge',
          EDGE_ID: 'test-edge',
          WAITING_PORT: String(waiting),
          AGENT_PORT: String(agentPort),
          NOTICE_PORT: String(notice),
          SLEEPING_PORT: String(sleeping),
          MINECRAFT_PORT: String(minecraft),
          ROUTER_PORT: String(router),
          ROUTER_API_PORT: String(routerApi),
          // No mc-router: the waiting room listens before the agent waits on it.
          ROUTER_BIN: 'true',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      })
      const bytes = Uint8Array.from([...handshake, ...login, ...negative])
      expect(await closedWithin(waiting ?? 0, bytes, 1_000)).toBe(true)
      expect(asked.filter((path) => path.endsWith('/wake'))).toEqual([])
    }, 20_000)
  })
})
