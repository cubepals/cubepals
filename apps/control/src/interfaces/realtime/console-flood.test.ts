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
import { stays, until } from '@blockly/contracts/waits'
import { Client } from 'transport-io'
import { connectWebSocket } from 'transport-io/websocket-transport'
import type { ConsoleFeed, ConsoleLine } from '../../app/console/feed.ts'
import type { EventBus } from '../../app/ports/events.ts'
import type { RealtimeTickets } from '../../app/ports/tickets.ts'
import { mintPinnedCertificate } from '../../infra/realtime/pinned-certificate.ts'
import { LINE_CHARS, LINES_PER_SECOND, SINGLE_LINES_PER_SECOND } from './console-batches.ts'
import { startRealtime } from './server.node.ts'

const ORIGIN = 'https://web.test'
/** Five times the cap, printed at once, as a mod logging in a loop does. */
const FLOOD = 5 * LINES_PER_SECOND

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = listenOn().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

/** A server that prints lines longer than any sent, as a mod dumping data in one line does. */
const LONG = randomUUID()
const LONG_LINES = 200

/** The flood, then quiet until the tail is ended. */
async function* flood(serverId: string, signal: AbortSignal): AsyncIterable<ConsoleLine> {
  if (serverId === LONG)
    for (let n = 0; n < LONG_LINES; n++)
      yield { at: new Date(1_700_000_000_000 + n), text: 'x'.repeat(4 * LINE_CHARS), level: 'info' }
  else
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

  /** A browser watching `serverId`'s console, as a page that takes batches or one from before them. */
  async function watcher(serverId: string, batched: boolean) {
    const client = new Client<RealtimeMap>({
      contract: realtimeContract,
      connect: () => connectWebSocket({ url: `ws://127.0.0.1:${fallbackPort}/transport-io?ticket=t` }),
    })
    const singles: string[] = []
    const batches: RealtimeMap['consoleLines']['payload'][] = []
    client.on('consoleLine', (line) => void singles.push(line.text))
    client.on('consoleLines', (batch) => void batches.push(batch))
    let status = ''
    const connected = new Promise<void>((resolve) =>
      client.onSession((state) => {
        status = state.status
        if (state.status === 'connected') resolve()
      }),
    )
    await client.connect()
    await connected
    client.emit('watch', batched ? { serverId, topic: 'console', batched } : { serverId, topic: 'console' })
    const shown = () => batches.reduce((sum, b) => sum + b.lines.length, 0)
    const counted = () => batches.reduce((sum, b) => sum + (b.unshown?.count ?? 0), 0)
    const seen = () =>
      `${singles.length} single lines, ${batches.length} batches: ${shown()} shown, ${counted()} counted`
    return { client, singles, batches, shown, counted, seen, status: () => status }
  }

  test('reaches a watcher that takes batches in a few messages, every line shown or counted', async () => {
    const w = await watcher(randomUUID(), true)
    await until('every line of the flood shown or counted', () => w.shown() + w.counted() === FLOOD, {
      seen: w.seen,
    })
    w.client.disconnect()

    expect(w.singles).toEqual([])
    expect(w.shown()).toBe(LINES_PER_SECOND)
    expect(w.counted()).toBe(FLOOD - LINES_PER_SECOND)
    // The lines that are shown come in order, the first of the flood.
    expect(w.batches.flatMap((b) => b.lines.map((l) => l.text)).slice(0, 3)).toEqual([
      'spam 0',
      'spam 1',
      'spam 2',
    ])
    expect(w.batches.length).toBeLessThanOrEqual(3)
  }, 20_000)

  test('reaches a page loaded before batches line by line, held to its own cap', async () => {
    const w = await watcher(randomUUID(), false)
    await until('the cap’s worth of single lines', () => w.singles.length >= SINGLE_LINES_PER_SECOND, {
      seen: w.seen,
    })
    await stays('no more than the cap', () => w.singles.length === SINGLE_LINES_PER_SECOND, 1_500, {
      seen: w.seen,
    })
    // Still connected: a burst past transport-io's queue would have closed the session.
    expect(w.status()).toBe('connected')
    w.client.disconnect()

    expect(w.batches).toEqual([])
    expect(w.singles.slice(0, 3)).toEqual(['spam 0', 'spam 1', 'spam 2'])
  }, 20_000)

  test('carries long lines in messages transport-io takes', async () => {
    const w = await watcher(LONG, true)
    await until('every long line shown', () => w.shown() === LONG_LINES, { seen: w.seen })
    w.client.disconnect()
    expect(w.batches.length).toBeGreaterThan(1)
    expect(w.batches.flatMap((b) => b.lines).every((l) => l.text.length === LINE_CHARS + 1)).toBe(true)
  }, 20_000)
})
