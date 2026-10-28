// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import { LOCAL_HEADER, readProxyHeader } from '@blockly/contracts/proxy-header'
import { SlpProbe } from './slp.ts'

function varInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    bytes.push(byte)
  } while (v !== 0)
  return Buffer.from(bytes)
}

/** A status reply exactly as a server frames it: length, packet id 0, then the JSON string. */
function statusReply(json: object): Buffer {
  const text = Buffer.from(JSON.stringify(json))
  const body = Buffer.concat([varInt(0), varInt(text.length), text])
  return Buffer.concat([varInt(body.length), body])
}

const STATUS = { version: { name: '26.3', protocol: 775 }, players: { max: 4, online: 1 }, description: 'x' }

function fakeServer(behave: (socket: Socket) => void): Promise<Server> {
  const server = createServer((socket) => socket.once('data', () => behave(socket)))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

let server: Server | null = null
afterEach(() => server?.close())

const ping = (s: Server, timeoutMs = 1000, proxyProtocol = false) => {
  const address = s.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return new SlpProbe().ping(
    { host: '127.0.0.1', port: address.port, proxyProtocol },
    AbortSignal.timeout(timeoutMs),
  )
}

describe('SlpProbe', () => {
  test('reads the version and player counts', async () => {
    server = await fakeServer((socket) => socket.write(statusReply(STATUS)))
    expect(await ping(server)).toEqual({ version: '26.3', online: 1, max: 4 })
  })

  test('joins a reply that arrives one byte at a time', async () => {
    server = await fakeServer(async (socket) => {
      for (const byte of statusReply(STATUS)) {
        socket.write(Buffer.from([byte]))
        await Bun.sleep(1)
      }
    })
    expect(await ping(server)).toEqual({ version: '26.3', online: 1, max: 4 })
  })

  test('a reply that names no version is no server yet', async () => {
    server = await fakeServer((socket) => socket.write(statusReply({ description: 'Starting' })))
    await expect(ping(server)).rejects.toThrow('before Minecraft was up')
  })

  // mc-router closes without a word for a name it has no route for.
  test('a server that closes without answering fails at once, not at the deadline', async () => {
    server = await fakeServer((socket) => socket.destroy())
    const started = Date.now()
    // Awaited directly: under Bun 1.4.3's test runner, this ping awaited through `expect().rejects`
    // sometimes takes most of a second to fail; awaited directly, it fails within milliseconds.
    const failure = await ping(server, 5000).then(
      () => null,
      (error: unknown) => error,
    )
    expect(Date.now() - started).toBeLessThan(500)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('closed the connection without answering')
  })

  test('a server that reads a PROXY header is sent a LOCAL one first, and any other none', async () => {
    const opened: Buffer[] = []
    server = await fakeServer((socket) => socket.write(statusReply(STATUS)))
    server.on('connection', (socket) => socket.once('data', (chunk) => opened.push(chunk)))
    await ping(server, 1000, true)
    await ping(server)
    const [proxied, plain] = opened.map((chunk) => readProxyHeader(new Uint8Array(chunk)))
    expect(proxied).toEqual({ source: null, next: LOCAL_HEADER.length })
    expect(plain).toBe('none')
  })

  test('a server that never answers fails at the deadline', async () => {
    server = await fakeServer(() => {})
    await expect(ping(server, 200)).rejects.toThrow('timed out')
  })

  test('a reply declaring more than a status string can hold fails at once', async () => {
    server = await fakeServer((socket) => socket.write(Buffer.concat([varInt(1_000_000), Buffer.alloc(64)])))
    const started = Date.now()
    await expect(ping(server, 5000)).rejects.toThrow('A status reply of 1000000 bytes is outside 1 to 98305')
    expect(Date.now() - started).toBeLessThan(500)
  })

  test('a reply whose length reads as negative fails at once', async () => {
    server = await fakeServer((socket) => socket.write(Buffer.from([0xfd, 0xff, 0xff, 0xff, 0x0f, 0])))
    await expect(ping(server, 5000)).rejects.toThrow('A status reply of -3 bytes is outside 1 to 98305')
  })

  test('a string longer than its reply fails', async () => {
    const body = Buffer.concat([varInt(0), varInt(500), Buffer.from('{}')])
    server = await fakeServer((socket) => socket.write(Buffer.concat([varInt(body.length), body])))
    await expect(ping(server)).rejects.toThrow('shorter than the string it declares')
  })

  test('a status as long as a status string can be is read', async () => {
    const description = '€'.repeat(32_000)
    server = await fakeServer((socket) => socket.write(statusReply({ ...STATUS, description })))
    expect(await ping(server)).toEqual({ version: '26.3', online: 1, max: 4 })
  })
})
