// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * transport-io calls each `on` handler without awaiting or catching what it returns, and under
 * Node an unhandled rejection ends the process. So the realtime role's async handlers settle
 * every promise themselves: a `watch` from a peer that leaves while the database is checked
 * (the join then finds the session closed) is routine, and realtime keeps every other session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer as listenOn } from 'node:net'
import { type RealtimeMap, realtimeContract } from '@blockly/contracts/realtime'
import { Client } from 'transport-io'
import { connectWebSocket } from 'transport-io/websocket-transport'
import type { ConsoleFeed } from '../../app/console/feed.ts'
import type { EventBus } from '../../app/ports/events.ts'
import type { RealtimeTickets } from '../../app/ports/tickets.ts'
import { mintPinnedCertificate } from '../../infra/realtime/pinned-certificate.ts'
import { startRealtime } from './server.node.ts'

const ORIGIN = 'https://web.test'

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = listenOn().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe('a watch from a peer that leaves while it is checked', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  let realtime: { stop(): Promise<void> }
  let fallbackPort: number
  const NativeWebSocket = globalThis.WebSocket

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled)
    // A browser names its page's origin; Bun's client sends none unless asked.
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, { headers: { Origin: ORIGIN }, ...(protocols ? { protocols } : {}) } as never)
      }
    } as typeof WebSocket
    const cert = await mintPinnedCertificate('127.0.0.1')
    fallbackPort = await freePort()
    const events: EventBus = { publish: async () => {}, subscribe: async () => async () => {} }
    const tickets: RealtimeTickets = { issue: async () => 'ticket', verify: async () => 'user-1' }
    // The database takes a moment to say whose the server is, as it does under any load.
    const feed = {
      canWatch: async () => {
        await Bun.sleep(300)
        return true
      },
      recent: async () => [],
      tail: async function* () {},
    } as unknown as ConsoleFeed
    realtime = await startRealtime({
      listen: { host: '127.0.0.1', port: await freePort() },
      fallbackListen: { host: '127.0.0.1', port: fallbackPort },
      tls: { cert: cert.cert, privKey: cert.privKey },
      allowedOrigins: [ORIGIN],
      events,
      tickets,
      console: feed,
      presence: async () => [],
    })
  })

  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled)
    globalThis.WebSocket = NativeWebSocket
    await realtime?.stop()
  })

  test('never leaves a rejection nothing handles', async () => {
    const client = new Client<RealtimeMap>({
      contract: realtimeContract,
      connect: () => connectWebSocket({ url: `ws://127.0.0.1:${fallbackPort}/transport-io?ticket=t` }),
    })
    const connected = new Promise<void>((resolve) =>
      client.onSession((state) => state.status === 'connected' && resolve()),
    )
    await client.connect()
    await connected
    client.emit('watch', { serverId: randomUUID(), topic: 'console' })
    await Bun.sleep(50)
    client.disconnect()
    await Bun.sleep(1_000)
    expect(unhandled.map((reason) => String((reason as Error)?.message ?? reason))).toEqual([])
  }, 20_000)
})
