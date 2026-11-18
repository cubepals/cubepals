// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server flooding its console, through the real transport: its watchers get the lines gathered
 * into a few messages, never one message per line, with the lines past the cap counted, and every
 * line accounted for, shown or counted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer as listenOn } from 'node:net'
import { type RealtimeMap, realtimeContract } from '@blockly/contracts/realtime'
import { until } from '@blockly/contracts/waits'
import { Client } from 'transport-io'
import { connectWebSocket } from 'transport-io/websocket-transport'
import type { ConsoleFeed, ConsoleLine } from '../../app/console/feed.ts'
import type { EventBus } from '../../app/ports/events.ts'
import type { RealtimeTickets } from '../../app/ports/tickets.ts'
import { mintPinnedCertificate } from '../../infra/realtime/pinned-certificate.ts'
import { LINES_PER_SECOND } from './console-batches.ts'
import { startRealtime } from './server.node.ts'

const ORIGIN = 'https://web.test'
const SERVER = randomUUID()
/** Five times the cap, printed at once, as a mod logging in a loop does. */
const FLOOD = 5 * LINES_PER_SECOND

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = listenOn().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

/** The flood, then quiet until the tail is ended. */
async function* flood(_serverId: string, signal: AbortSignal): AsyncIterable<ConsoleLine> {
  for (let n = 0; n < FLOOD; n++)
    yield { at: new Date(1_700_000_000_000 + n), text: `spam ${n}`, level: 'info' }
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
}

describe('a server flooding its console', () => {
  let realtime: { stop(): Promise<void> }
  let fallbackPort: number
  const NativeWebSocket = globalThis.WebSocket

  beforeAll(async () => {
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, { headers: { Origin: ORIGIN }, ...(protocols ? { protocols } : {}) } as never)
      }
    } as typeof WebSocket
    const cert = await mintPinnedCertificate('127.0.0.1')
    fallbackPort = await freePort()
    const events: EventBus = { publish: async () => {}, subscribe: async () => async () => {} }
    const tickets: RealtimeTickets = {
      issue: async () => 'ticket',
      verify: async () => ({ userId: 'user-1', sessionId: 'session-1' }),
    }
    const feed = {
      canWatch: async () => true,
      stillSignedIn: async () => true,
      mayOpen: async () => true,
      recent: async () => [],
      tail: flood,
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
    globalThis.WebSocket = NativeWebSocket
    await realtime?.stop()
  })

  test('reaches its watcher in a few messages, every line shown or counted', async () => {
    const client = new Client<RealtimeMap>({
      contract: realtimeContract,
      connect: () => connectWebSocket({ url: `ws://127.0.0.1:${fallbackPort}/transport-io?ticket=t` }),
    })
    let single = 0
    const batches: RealtimeMap['consoleLines']['payload'][] = []
    client.on('consoleLine', () => void single++)
    client.on('consoleLines', (batch) => void batches.push(batch))
    const connected = new Promise<void>((resolve) =>
      client.onSession((state) => state.status === 'connected' && resolve()),
    )
    await client.connect()
    await connected
    client.emit('watch', { serverId: SERVER, topic: 'console' })

    const shown = () => batches.reduce((sum, b) => sum + b.lines.length, 0)
    const counted = () => batches.reduce((sum, b) => sum + (b.unshown?.count ?? 0), 0)
    await until(
      'every line of the flood shown or counted',
      () => shown() + counted() === FLOOD || single > 0,
      {
        seen: () =>
          `${single} single lines, ${batches.length} batches: ${shown()} shown, ${counted()} counted`,
      },
    )
    client.disconnect()

    expect(single).toBe(0)
    expect(shown()).toBe(LINES_PER_SECOND)
    expect(counted()).toBe(FLOOD - LINES_PER_SECOND)
    // The lines that are shown come in order, the first of the flood.
    expect(batches.flatMap((b) => b.lines.map((l) => l.text)).slice(0, 3)).toEqual([
      'spam 0',
      'spam 1',
      'spam 2',
    ])
    expect(batches.length).toBeLessThanOrEqual(3)
  }, 20_000)
})
