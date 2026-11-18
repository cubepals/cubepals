// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operator watching one server's console from the operators' tools, through the real transport
 * and real tickets: the console its ticket names opens and streams, any other is refused, it joins
 * no account's room, and the session ends when its time is up.
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
import { JoseRealtimeTickets } from '../../infra/realtime/jose-tickets.ts'
import { mintPinnedCertificate } from '../../infra/realtime/pinned-certificate.ts'
import { startRealtime } from './server.node.ts'

const ORIGIN = 'https://web.test'
const WATCHED = randomUUID()
const OTHER = randomUUID()
const RECHECK_MS = 100
const WATCH_MS = 1_500

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = listenOn().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

/** Three lines from the server being watched, then quiet until the tail is ended. */
async function* printing(serverId: string, signal: AbortSignal): AsyncIterable<ConsoleLine> {
  for (let n = 0; n < 3; n++)
    yield { at: new Date(1_700_000_000_000 + n), text: `${serverId} ${n}`, level: 'info' }
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
}

describe('an operator watching a console', () => {
  let realtime: { stop(): Promise<void> }
  let fallbackPort: number
  const tickets = new JoseRealtimeTickets('ticket-secret-0123456789abcdef', 'test')
  /** Every check a person's watch makes; an operator's makes none of them. */
  const asked: string[] = []
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
    const feed = {
      canWatch: async () => {
        asked.push('canWatch')
        return false
      },
      stillSignedIn: async () => {
        asked.push('stillSignedIn')
        return false
      },
      mayOpen: async () => {
        asked.push('mayOpen')
        return false
      },
      recent: async (serverId: string) => [{ at: new Date(0), text: `${serverId} before`, level: 'info' }],
      tail: printing,
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
      recheckMs: RECHECK_MS,
      operatorWatchMs: WATCH_MS,
    })
  })

  afterAll(async () => {
    globalThis.WebSocket = NativeWebSocket
    await realtime?.stop()
  })

  /** A session opened with an operator's ticket for WATCHED, and what it was sent. */
  async function operator() {
    const ticket = await tickets.issueForOperator({ operator: 'ops-agent', serverId: WATCHED })
    const client = new Client<RealtimeMap>({
      contract: realtimeContract,
      connect: () =>
        connectWebSocket({ url: `ws://127.0.0.1:${fallbackPort}/transport-io?ticket=${ticket}` }),
    })
    const histories: string[] = []
    const lines: string[] = []
    client.on('consoleHistory', ({ serverId }) => void histories.push(serverId))
    client.on('consoleLines', (batch) => void lines.push(...batch.lines.map((l) => l.text)))
    const connected = new Promise<void>((resolve) =>
      client.onSession((state) => state.status === 'connected' && resolve()),
    )
    await client.connect()
    await connected
    return { client, histories, lines, snapshot: () => client.getSnapshot() }
  }

  test('streams the console its ticket names, refuses any other, and asks nothing of an account', async () => {
    const o = await operator()
    o.client.emit('watch', { serverId: OTHER, topic: 'console', batched: true })
    o.client.emit('watch', { serverId: WATCHED, topic: 'console', batched: true })
    const seen = () =>
      `histories ${o.histories.join(',')}; lines ${o.lines.join(',')}; rooms ${o.snapshot().rooms.join(',')}`
    await until('the watched console’s history and its lines', () => o.lines.length === 3, { seen })
    expect(o.histories).toEqual([WATCHED])
    expect(o.lines).toEqual([`${WATCHED} 0`, `${WATCHED} 1`, `${WATCHED} 2`])
    expect(o.snapshot().rooms).toEqual([`console:${WATCHED}`])
    expect(asked).toEqual([])
    o.client.disconnect()
  }, 20_000)

  test('ends the session when its time is up', async () => {
    const o = await operator()
    o.client.emit('watch', { serverId: WATCHED, topic: 'console', batched: true })
    await until('the session to close', () => o.snapshot().status === 'closed', {
      seen: () => `status ${o.snapshot().status}`,
      timeoutMs: WATCH_MS + 10 * RECHECK_MS + 5_000,
    })
    expect(o.snapshot().refused?.reason).toBe('watch over')
  }, 20_000)

  test('from a tool that names no origin, opens with an operator’s ticket and never with a person’s', async () => {
    const PagesWebSocket = globalThis.WebSocket
    globalThis.WebSocket = NativeWebSocket
    try {
      const open = async (ticket: string) => {
        const client = new Client<RealtimeMap>({
          contract: realtimeContract,
          connect: () =>
            connectWebSocket({ url: `ws://127.0.0.1:${fallbackPort}/transport-io?ticket=${ticket}` }),
        })
        await client.connect().catch(() => undefined)
        await until('an answer to the connect', () => client.getSnapshot().status !== 'connecting', {
          seen: () => `status ${client.getSnapshot().status}`,
        })
        const answer = client.getSnapshot()
        client.disconnect()
        return { status: answer.status, refused: answer.refused?.reason ?? null }
      }
      const operatorTicket = await tickets.issueForOperator({ operator: 'ops-agent', serverId: WATCHED })
      expect(await open(operatorTicket)).toEqual({ status: 'connected', refused: null })
      const personTicket = await tickets.issue({ userId: 'user-1', sessionId: 'session-1' })
      expect(await open(personTicket)).toEqual({ status: 'closed', refused: 'origin' })
    } finally {
      globalThis.WebSocket = PagesWebSocket
    }
  }, 20_000)
})
