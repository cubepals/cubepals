// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The checks' join against the edge's own front door and sleeping server's notice: it speaks a game
 * the server takes, so the join reaches the wake, where a placeholder number was turned away first.
 */

import { afterEach, expect, test } from 'bun:test'
import { type AddressInfo, createServer, type Server } from 'node:net'
import { takes, wrongGame } from '../../apps/edge/clients.ts'
import { front } from '../../apps/edge/front.ts'
import { Gate } from '../../apps/edge/limits.ts'
import { Notice, packet } from '../../apps/edge/notice.ts'
import { join } from './minecraft.ts'

/** A sleeping 26.3 server with no Via plugins, as the staging check makes. */
const JOINS = { release: '26.3', protocol: 777, oldest: 777, newest: 777 }
const ROOMY = {
  address: { connections: { perSecond: 100, burst: 100 }, greeting: 100, open: 100 },
  server: { connections: { perSecond: 100, burst: 100 }, open: 100 },
}

const open: Server[] = []
afterEach(() => {
  for (const server of open.splice(0)) server.close()
})

const listening = (server: Server) =>
  new Promise<number>((resolve) =>
    server.once('listening', () => resolve((server.address() as AddressInfo).port)),
  )

/**
 * The edge for one sleeping server: the front door, turning away games outside `JOINS`, and behind
 * it the sleeping notice, which answers a ping and wakes the server for a join, answering as the
 * server then does. The protocol of each join that woke it is kept.
 */
async function sleepingEdge(): Promise<{ port: number; woken: number[] }> {
  const woken: number[] = []
  const notice = createServer((socket) => {
    const conversation = new Notice({ status: 'Sleeping · join to wake it up', join: null, joins: JOINS })
    socket.on('data', (chunk) => {
      const { reply, close, join } = conversation.receive(chunk)
      for (const bytes of reply) socket.write(bytes)
      if (join) {
        woken.push(join.protocol)
        // The woken server asks for an account, as an online-mode server does.
        socket.end(packet(0x01, [0]))
      } else if (close) socket.end()
    })
    socket.on('error', () => undefined)
  }).listen(0, '127.0.0.1')
  open.push(notice)
  const listener = front({
    port: 0,
    router: await listening(notice),
    proxied: false,
    gate: new Gate(ROOMY),
    known: () => true,
    plain: () => true,
    busy: 'Busy',
    refuse: (_hostname, protocol) => (takes(JOINS, protocol) ? null : wrongGame(JOINS, protocol, [])),
    timeouts: { connectMs: 1_000, idleMs: 60_000 },
  })
  open.push(listener)
  return { port: await listening(listener), woken }
}

test('a sleeping server’s join with the check’s protocol reaches the wake', async () => {
  const { port, woken } = await sleepingEdge()
  await join({ host: '127.0.0.1', port }, 'sleepy.play.test', 'Checker', 10_000)
  expect(woken).toEqual([777])
})
