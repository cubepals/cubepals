// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A real mc-router for tests, from `MC_ROUTER_BIN` (CI copies it out of the edge's own image), with
 * stand-in game servers behind it and a server list's ping in front.
 *
 * Not for the edge itself, which supervises mc-router in agent.ts.
 */
import { type AddressInfo, connect, createServer, type Server } from 'node:net'
import { Notice, readVarInt, statusRequest } from './notice.ts'

/** Where tests find mc-router; tests that need it are skipped where it isn't. */
export const ROUTER_BIN = process.env.MC_ROUTER_BIN ?? ''

/** A port nothing listens on just now. */
async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

export interface RunningRouter {
  /** Where players connect. */
  port: number
  /** Its API, as router.ts takes it. */
  api: string
  stop(): Promise<void>
}

/** Starts mc-router with routes only from its API, as the edge runs it. */
export async function startRouter(): Promise<RunningRouter> {
  const [port, apiPort] = [await freePort(), await freePort()]
  const child = Bun.spawn(
    [
      ROUTER_BIN,
      '-port',
      String(port),
      '-api-binding',
      `127.0.0.1:${apiPort}`,
      '-connection-rate-limit',
      '1000',
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  )
  return {
    port,
    api: `http://127.0.0.1:${apiPort}`,
    async stop() {
      child.kill()
      await child.exited
    },
  }
}

/** A stand-in game server that answers a ping with `says`; where it listens, as a route names it. */
export async function answering(says: string, servers: Server[]): Promise<string> {
  const server = createServer((socket) => {
    const notice = new Notice({ status: says, join: says })
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk) => {
      const { reply, close } = notice.receive(chunk)
      for (const bytes of reply) socket.write(bytes)
      if (close) socket.end()
    })
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  servers.push(server)
  return `127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** What a server list is told when it pings `hostname` at `port`; `closed` when nothing answered. */
export function ping(port: number, hostname: string): Promise<string> {
  return new Promise((resolve) => {
    let received = Buffer.alloc(0)
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(statusRequest(hostname, 25565)))
    socket.setTimeout(5_000, () => socket.destroy())
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      const length = readVarInt(received, 0)
      if (length === null || received.length < length.next + length.value) return
      const id = readVarInt(received, length.next)
      const text = id && readVarInt(received, id.next)
      socket.destroy()
      if (!text) return resolve('closed')
      const status = JSON.parse(received.subarray(text.next, text.next + text.value).toString())
      resolve(String(status.description?.text ?? ''))
    })
    socket.on('close', () => resolve('closed'))
  })
}
