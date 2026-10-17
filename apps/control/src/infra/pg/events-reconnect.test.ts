// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The event bus keeps its LISTEN connection: after Postgres has been away for longer than one
 * retry (a failover, a restart), it keeps trying until Postgres is back, then hears events again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import pg from 'pg'
import type { DomainEvent } from '../../app/ports/events.ts'
import { PgNotifyEventBus } from './events.ts'

const base = process.env.DATABASE_URL

/** A TCP proxy to Postgres that can be taken down (every connection cut, new ones refused). */
function proxyTo(target: URL) {
  let down = false
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    if (down) {
      client.destroy()
      return
    }
    const upstream = net.connect(Number(target.port || 5432), target.hostname)
    sockets.add(client)
    sockets.add(upstream)
    client.pipe(upstream)
    upstream.pipe(client)
    const close = () => {
      client.destroy()
      upstream.destroy()
      sockets.delete(client)
      sockets.delete(upstream)
    }
    client.on('error', close)
    upstream.on('error', close)
    client.on('close', close)
    upstream.on('close', close)
  })
  return {
    listen: () =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
      ),
    takeDown: () => {
      down = true
      for (const socket of sockets) socket.destroy()
    },
    bringUp: () => {
      down = false
    },
    close: () => server.close(),
  }
}

describe.skipIf(!base)('the event bus after Postgres was away for a few seconds', () => {
  const target = new URL(base as string)
  const proxy = proxyTo(target)
  let url: string
  beforeAll(async () => {
    const port = await proxy.listen()
    const via = new URL(base as string)
    via.hostname = '127.0.0.1'
    via.port = String(port)
    url = via.toString()
  })
  afterAll(() => proxy.close())

  test('hears events again once Postgres is back', async () => {
    const bus = new PgNotifyEventBus(url)
    const heard: DomainEvent[] = []
    await bus.subscribe((event) => heard.push(event))

    // Postgres goes away for three seconds: longer than a single retry a second after the loss.
    proxy.takeDown()
    await Bun.sleep(3_000)
    proxy.bringUp()
    // Ample time for any retry schedule worth having.
    await Bun.sleep(5_000)

    const serverId = randomUUID()
    const publisher = new pg.Client({ connectionString: base })
    await publisher.connect()
    await publisher.query(`select pg_notify('blockly_events', $1)`, [
      JSON.stringify({ type: 'backup_changed', serverId, ownerId: randomUUID() }),
    ])
    await publisher.end()
    await Bun.sleep(500)
    await bus.close()

    expect(heard.map((event) => (event as { serverId: string }).serverId)).toContain(serverId)
  }, 20_000)
})
