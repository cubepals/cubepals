// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Realtime asked from outside, against a real realtime server on loopback: its own refusal over
 * either transport is up, and an answer that isn't realtime's is down, whatever port was open.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer as listenOn } from 'node:net'
import { REALTIME_FALLBACK_PATH } from '@blockly/contracts/realtime'
import type { ConsoleFeed } from '../../apps/control/src/app/console/feed.ts'
import type { EventBus } from '../../apps/control/src/app/ports/events.ts'
import type { RealtimeTickets } from '../../apps/control/src/app/ports/tickets.ts'
import { mintPinnedCertificate } from '../../apps/control/src/infra/realtime/pinned-certificate.ts'
import { startRealtime } from '../../apps/control/src/interfaces/realtime/server.node.ts'
import { askRealtime } from './realtime-probe.node.ts'

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = listenOn().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

const events: EventBus = { publish: async () => {}, subscribe: async () => async () => {} }
const tickets: RealtimeTickets = { issue: async () => 'ticket', verify: async () => null }
const feed = {} as unknown as ConsoleFeed

let realtime: { stop(): Promise<void> }
let urls: { webtransport: string; websocket: string }
let certificateHash: Uint8Array

beforeAll(async () => {
  const cert = await mintPinnedCertificate('127.0.0.1')
  certificateHash = Uint8Array.from(Buffer.from(cert.sha256, 'hex'))
  const port = await freePort()
  const fallbackPort = await freePort()
  realtime = await startRealtime({
    listen: { host: '127.0.0.1', port },
    fallbackListen: { host: '127.0.0.1', port: fallbackPort },
    tls: { cert: cert.cert, privKey: cert.privKey },
    allowedOrigins: ['https://web.test'],
    events,
    tickets,
    console: feed,
    presence: async () => [],
  })
  urls = {
    webtransport: `https://127.0.0.1:${port}/`,
    websocket: `ws://127.0.0.1:${fallbackPort}${REALTIME_FALLBACK_PATH}`,
  }
}, 20_000)
afterAll(() => realtime.stop())

describe('realtime asked from outside', () => {
  test('is up over WebTransport and the WebSocket fallback when realtime itself refuses', async () => {
    const answers = await askRealtime(urls, { certificateHash })
    expect(answers.map((a) => [a.transport, a.up])).toEqual([
      ['webtransport', true],
      ['websocket', true],
    ])
    for (const answer of answers) expect(answer.said).toContain('refused by realtime ("origin")')
  }, 20_000)

  test('is down where nothing listens, saying there was no handshake', async () => {
    const [answer] = await askRealtime({
      websocket: `ws://127.0.0.1:${await freePort()}${REALTIME_FALLBACK_PATH}`,
    })
    expect(answer?.up).toBe(false)
    expect(answer?.said).toStartWith('no handshake')
  })

  test('is down when something else answers the handshake and closes without realtime’s refusal', async () => {
    const other = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('no', { status: 400 })),
      websocket: { open: (socket) => socket.close(1000, 'goodbye'), message: () => {} },
    })
    try {
      const [answer] = await askRealtime({
        websocket: `ws://127.0.0.1:${other.port}${REALTIME_FALLBACK_PATH}`,
      })
      expect(answer?.up).toBe(false)
      expect(answer?.said).toContain("closed without realtime's refusal (goodbye)")
    } finally {
      other.stop(true)
    }
  })
})
