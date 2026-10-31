// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The upstream idle timer closes both sides even when the client's timer is disabled. */
import { expect, test } from 'bun:test'
import { once } from 'node:events'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { pipe } from './front.ts'

test(
  'an idle upstream closes the forwarded connection',
  async () => {
    const sockets: Socket[] = []
    const destination = createServer((socket) => {
      sockets.push(socket)
      socket.resume()
    })
    const entrance = createServer()
    try {
      destination.listen(0, '127.0.0.1')
      entrance.listen(0, '127.0.0.1')
      await Promise.all([once(destination, 'listening'), once(entrance, 'listening')])
      const accepted = once(entrance, 'connection')
      const peer = connect((entrance.address() as AddressInfo).port, '127.0.0.1')
      sockets.push(peer)
      peer.resume()
      const [client] = (await accepted) as [Socket]
      sockets.push(client)
      const upstream = pipe(
        client,
        `127.0.0.1:${(destination.address() as AddressInfo).port}`,
        new TextEncoder().encode('hello'),
        { connectMs: SECOND_MS, idleMs: SECOND_MS / 20 },
      )
      sockets.push(upstream)
      client.setTimeout(0)
      const upstreamClosed = once(upstream, 'close')
      const clientClosed = once(client, 'close')
      const peerClosed = once(peer, 'close')
      await once(upstream, 'timeout')
      expect(upstream.destroyed).toBe(true)
      await Promise.all([upstreamClosed, clientClosed, peerClosed])
      expect(client.destroyed).toBe(true)
      expect(peer.destroyed).toBe(true)
    } finally {
      for (const socket of sockets) socket.destroy()
      destination.close()
      entrance.close()
    }
  },
  5 * SECOND_MS,
)
