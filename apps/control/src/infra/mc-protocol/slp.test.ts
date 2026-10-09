import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
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

const ping = (s: Server, timeoutMs = 1000) => {
  const address = s.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return new SlpProbe().ping({ host: '127.0.0.1', port: address.port }, AbortSignal.timeout(timeoutMs))
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
    await expect(ping(server, 5000)).rejects.toThrow('closed the connection without answering')
    expect(Date.now() - started).toBeLessThan(500)
  })

  test('a server that never answers fails at the deadline', async () => {
    server = await fakeServer(() => {})
    await expect(ping(server, 200)).rejects.toThrow('timed out')
  })
})
