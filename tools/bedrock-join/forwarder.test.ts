// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test } from 'bun:test'
import { createSocket, type Socket } from 'node:dgram'
import { FLY_UDP_MTU, type Forwarder, forwarder } from './forwarder.ts'

const opened: { close: () => void }[] = []
afterEach(() => {
  for (const one of opened.splice(0)) one.close()
})

async function bound(): Promise<Socket> {
  const socket = createSocket('udp4')
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
  opened.push(socket)
  return socket
}

/** An edge that answers each datagram with its length, and remembers who sent it. */
async function edge(): Promise<{ socket: Socket; heard: { bytes: number; port: number }[] }> {
  const socket = await bound()
  const heard: { bytes: number; port: number }[] = []
  socket.on('message', (message, from) => {
    heard.push({ bytes: message.length, port: from.port })
    socket.send(String(message.length), from.port, from.address)
  })
  return { socket, heard }
}

async function through(far: Socket, mtu = FLY_UDP_MTU): Promise<Forwarder> {
  const forwarding = await forwarder({ host: '127.0.0.1', port: far.address().port, family: 'udp4' }, mtu)
  opened.push(forwarding)
  return forwarding
}

/**
 * What `client` is answered: once `expected` answers came, or a while passed, and a moment more, so
 * an answer that shouldn't come has had time to.
 */
function answers(client: Socket, expected: number): Promise<string[]> {
  const got: string[] = []
  return new Promise((resolve) => {
    const settle = () => setTimeout(() => resolve(got), 100)
    const giveUp = setTimeout(settle, 2000)
    client.on('message', (message) => {
      got.push(message.toString())
      if (got.length === expected) {
        clearTimeout(giveUp)
        settle()
      }
    })
  })
}

// RakNet's open requests, padded to each MTU it tries less the 28 bytes of IP and UDP headers.
const OPEN_AT_1492 = 1492 - 28
const OPEN_AT_1200 = 1200 - 28

test('drops a datagram larger than Fly carries before it leaves, and passes the rest both ways', async () => {
  const far = await edge()
  const forwarding = await through(far.socket)
  const client = await bound()
  const heard = answers(client, 1)
  client.send(Buffer.alloc(OPEN_AT_1492), forwarding.port, '127.0.0.1')
  client.send(Buffer.alloc(OPEN_AT_1200), forwarding.port, '127.0.0.1')
  expect(await heard).toEqual([String(OPEN_AT_1200)])
  expect(far.heard.map((h) => h.bytes)).toEqual([OPEN_AT_1200])
})

test('a datagram exactly the MTU passes; one byte more does not', async () => {
  const far = await edge()
  const forwarding = await through(far.socket, 600)
  const client = await bound()
  const heard = answers(client, 1)
  client.send(Buffer.alloc(600 - 28), forwarding.port, '127.0.0.1')
  client.send(Buffer.alloc(600 - 28 + 1), forwarding.port, '127.0.0.1')
  expect(await heard).toEqual([String(600 - 28)])
})

test('each client socket reaches the edge from a socket of its own', async () => {
  const far = await edge()
  const forwarding = await through(far.socket)
  const first = await bound()
  const second = await bound()
  const heard = Promise.all([answers(first, 2), answers(second, 1)])
  first.send('a', forwarding.port, '127.0.0.1')
  second.send('bb', forwarding.port, '127.0.0.1')
  first.send('ccc', forwarding.port, '127.0.0.1')
  expect(await heard).toEqual([['1', '3'], ['2']])
  const ports = new Map(far.heard.map((h) => [h.bytes, h.port]))
  expect(ports.get(1)).toBe(ports.get(3))
  expect(ports.get(1)).not.toBe(ports.get(2))
})
