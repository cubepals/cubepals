// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A domain event can reach the realtime role the moment it subscribes, as one did while the
 * control plane started: a server's status changed as the database's listener connected. The
 * role takes events only once its server listens, so such an event never reaches rooms that
 * aren't there yet, which ended the process.
 */
import { describe, expect, test } from 'bun:test'
import { createServer as listenOn } from 'node:net'
import type { ConsoleFeed } from '../../app/console/feed.ts'
import type { DomainEvent, EventBus } from '../../app/ports/events.ts'
import type { RealtimeTickets } from '../../app/ports/tickets.ts'
import { mintPinnedCertificate } from '../../infra/realtime/pinned-certificate.ts'
import { startRealtime } from './server.node.ts'

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = listenOn().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe('an event that arrives as realtime subscribes', () => {
  test('is forwarded, and realtime starts', async () => {
    const changed = {
      type: 'server_changed',
      serverId: 'server-1',
      ownerId: 'user-1',
      status: 'running',
      version: 2,
    } as unknown as DomainEvent
    // The database's listener hands over an event before subscribe has even returned.
    const events: EventBus = {
      publish: async () => {},
      subscribe: async (handler) => {
        handler(changed)
        return async () => {}
      },
    }
    const tickets: RealtimeTickets = {
      issue: async () => 'ticket',
      verify: async () => ({ userId: 'user-1', sessionId: 'session-1' }),
    }
    const feed = {
      canWatch: async () => true,
      stillSignedIn: async () => true,
      mayOpen: async () => true,
      recent: async () => [],
      tail: async function* () {},
    } as unknown as ConsoleFeed
    const cert = await mintPinnedCertificate('127.0.0.1')
    const realtime = await startRealtime({
      listen: { host: '127.0.0.1', port: await freePort() },
      fallbackListen: { host: '127.0.0.1', port: await freePort() },
      tls: { cert: cert.cert, privKey: cert.privKey },
      allowedOrigins: ['https://web.test'],
      events,
      tickets,
      console: feed,
      presence: async () => [],
    })
    expect(realtime).toBeDefined()
    await realtime.stop()
  }, 20_000)
})
