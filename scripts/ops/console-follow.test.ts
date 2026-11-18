// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `ops.ts console --follow` against a real realtime role, with an operator's ticket and no origin,
 * as it runs against production: it prints the console's earlier lines, what it prints live, and
 * the count of lines not shown, then what it saw.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer as listenOn } from 'node:net'
import type { ConsoleFeed, ConsoleLine } from '../../apps/control/src/app/console/feed.ts'
import { JoseRealtimeTickets } from '../../apps/control/src/infra/realtime/jose-tickets.ts'
import { mintPinnedCertificate } from '../../apps/control/src/infra/realtime/pinned-certificate.ts'
import { LINES_PER_SECOND } from '../../apps/control/src/interfaces/realtime/console-batches.ts'
import { startRealtime } from '../../apps/control/src/interfaces/realtime/server.node.ts'
import { followConsole, followedLine } from './console-follow.ts'

const SERVER = randomUUID()
const PRINTED = LINES_PER_SECOND + 200

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = listenOn().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

async function* flood(_serverId: string, signal: AbortSignal): AsyncIterable<ConsoleLine> {
  for (let n = 0; n < PRINTED; n++)
    yield { at: new Date(1_700_000_000_000 + n), text: `line ${n}`, level: 'info' }
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
}

describe('following a console from the operators’ tools', () => {
  let realtime: { stop(): Promise<void> }
  let fallbackPort: number
  const tickets = new JoseRealtimeTickets('ticket-secret-0123456789abcdef', 'test')

  beforeAll(async () => {
    const cert = await mintPinnedCertificate('127.0.0.1')
    fallbackPort = await freePort()
    realtime = await startRealtime({
      listen: { host: '127.0.0.1', port: await freePort() },
      fallbackListen: { host: '127.0.0.1', port: fallbackPort },
      tls: { cert: cert.cert, privKey: cert.privKey },
      allowedOrigins: ['https://web.test'],
      events: { publish: async () => {}, subscribe: async () => async () => {} },
      tickets,
      console: {
        recent: async () => [{ at: new Date(0), text: 'Done (2.1s)!', level: 'info' }],
        tail: flood,
      } as unknown as ConsoleFeed,
      presence: async () => [],
    })
  })

  afterAll(async () => {
    await realtime?.stop()
  })

  test('prints the earlier lines, the live ones, and how many were not shown', async () => {
    const said: string[] = []
    const ticket = await tickets.issueForOperator({ operator: 'ops-agent', serverId: SERVER })
    const seen = await followConsole(
      { fallbackUrl: `ws://127.0.0.1:${fallbackPort}/transport-io`, ticket, serverId: SERVER },
      2,
      (line) => void said.push(line),
    )
    expect(seen).toEqual({ histories: 1, batches: 2, lines: LINES_PER_SECOND, notShown: 200, endedBy: null })
    expect(said[0]).toBe('1970-01-01T00:00:00.000Z  Done (2.1s)!')
    expect(
      said.some((line) =>
        line.endsWith('200 lines not shown: the server printed faster than anyone can read.'),
      ),
    ).toBe(true)
    expect(followedLine(seen)).toBe(
      `2 messages with ${LINES_PER_SECOND} lines, 200 not shown, after the earlier lines; stopped watching`,
    )
  }, 20_000)
})
