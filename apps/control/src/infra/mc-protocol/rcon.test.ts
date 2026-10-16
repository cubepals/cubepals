// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test } from 'bun:test'
import { connect, createServer, type Server, type Socket } from 'node:net'
import type { Locks } from '../../app/ports/locks.ts'
import { RconConsole } from './rcon.ts'

/** Locks for one process, which is all these tests need to show sessions taking turns. */
class LocalLocks implements Locks {
  readonly #tails = new Map<string, Promise<unknown>>()

  hold<T>(key: string, _waitMs: number, work: () => Promise<T>): Promise<T> {
    const turn = (this.#tails.get(key) ?? Promise.resolve()).then(work, work)
    this.#tails.set(
      key,
      turn.catch(() => undefined),
    )
    return turn
  }
}

const rcon = () => new RconConsole(new LocalLocks(), { connectMs: 300, commandMs: 300, comingUpMs: 1500 })

/**
 * A stand-in for vanilla's RCON: it parses one packet per read and drops the rest, splits long
 * answers into 4 KiB fragments, and answers unknown request types with "Unknown request".
 */
function vanillaRcon(
  password: string,
  answer: (command: string) => string,
  packets: number[] = [],
): Promise<Server> {
  const reply = (socket: Socket, id: number, type: number, body: string) => {
    const payload = Buffer.from(body)
    const buffer = Buffer.alloc(14 + payload.length)
    buffer.writeInt32LE(10 + payload.length, 0)
    buffer.writeInt32LE(id, 4)
    buffer.writeInt32LE(type, 8)
    payload.copy(buffer, 12)
    socket.write(buffer)
  }
  let connections = 0
  const server = createServer((socket) => {
    const connection = connections++
    let authed = false
    socket.on('data', (chunk) => {
      packets.push(connection)
      // Only the first packet in each read is seen, as in vanilla.
      const length = chunk.readInt32LE(0)
      const id = chunk.readInt32LE(4)
      const type = chunk.readInt32LE(8)
      const body = chunk.toString('utf8', 12, length + 2)
      if (type === 3) {
        authed = body === password
        reply(socket, authed ? id : -1, 2, '')
      } else if (type === 2 && authed) {
        const text = answer(body)
        for (let i = 0; i < text.length || i === 0; i += 4096) reply(socket, id, 0, text.slice(i, i + 4096))
      } else {
        reply(socket, id, 0, `Unknown request ${type.toString(16)}`)
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/**
 * A stand-in for Flycast: Fly's proxy accepts every connection, and closes it when the machine's
 * port doesn't take it. The first `closed` connections are closed so; the rest reach `console`.
 */
function flycast(console: Server, closed: number): Promise<Server> {
  const address = console.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  let connections = 0
  const proxy = createServer((socket) => {
    if (connections++ < closed) return socket.end()
    const upstream = connect(address.port, '127.0.0.1')
    socket.pipe(upstream).pipe(socket)
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  })
  return new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(proxy)))
}

let server: Server | null = null
let proxy: Server | null = null
afterEach(() => {
  server?.close()
  proxy?.close()
  proxy = null
})

const target = (s: Server, ...passwords: string[]) => {
  const address = s.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return {
    endpoint: { host: '127.0.0.1', port: address.port },
    passwords: passwords.length > 0 ? passwords : ['secret'],
  }
}

describe('RconConsole', () => {
  test('runs commands one after another on one connection', async () => {
    server = await vanillaRcon('secret', (command) => `ran ${command}`)
    const results = await rcon().runAll(target(server), ['whitelist add Steve', 'op Steve', 'whitelist on'])
    expect(results).toEqual([
      { ok: true, output: 'ran whitelist add Steve' },
      { ok: true, output: 'ran op Steve' },
      { ok: true, output: 'ran whitelist on' },
    ])
  })

  test('joins a long answer sent in fragments', async () => {
    const long = 'x'.repeat(10_000)
    server = await vanillaRcon('secret', () => long)
    expect(await rcon().run(target(server), 'list')).toBe(long)
  })

  test('a wrong password is refused, and every command in the batch reports it', async () => {
    server = await vanillaRcon('secret', () => '')
    const results = await rcon().runAll(target(server, 'wrong'), ['list', 'op Steve'])
    expect(results.every((r) => !r.ok)).toBe(true)
  })

  // During a key rotation a server not yet applied again still has the old key's password.
  test('the passwords are tried in order until one is accepted', async () => {
    server = await vanillaRcon('old-key-password', (command) => `ran ${command}`)
    expect(await rcon().run(target(server, 'new-key-password', 'old-key-password'), 'list')).toBe('ran list')
    await expect(rcon().run(target(server, 'new-key-password', 'another'), 'list')).rejects.toThrow(
      'The console refused the password',
    )
  })

  // Vanilla shares one answer buffer between RCON connections, so a command on a second
  // connection while the first's are being answered can take the first one's answer. Whether the
  // server has seen a finished connection close before the next one opens is not something a
  // client can know, so what is checked is that each connection's packets come in one run.
  test('sessions to one server take turns', async () => {
    const packets: number[] = []
    server = await vanillaRcon('secret', (command) => `ran ${command}`, packets)
    const console = rcon()
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => console.run(target(server as Server), `say ${i}`)),
    )
    expect(answers).toEqual(Array.from({ length: 8 }, (_, i) => `ran say ${i}`))
    const runs = packets.filter((connection, i) => connection !== packets[i - 1])
    expect(runs).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test('a server that accepts the connection and never answers is given up on', async () => {
    const silent = createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    server = silent
    const started = Date.now()
    await expect(rcon().run(target(silent), 'list')).rejects.toThrow('The console did not answer')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('a console that just came up and closes the first connection answers the next', async () => {
    server = await vanillaRcon('secret', (command) => `ran ${command}`)
    proxy = await flycast(server, 2)
    expect(await rcon().run(target(proxy), 'seed')).toBe('ran seed')
  })

  test('a console that keeps closing the connection is given up on after a while', async () => {
    server = await vanillaRcon('secret', (command) => `ran ${command}`)
    proxy = await flycast(server, Number.POSITIVE_INFINITY)
    const started = Date.now()
    await expect(rcon().run(target(proxy), 'seed')).rejects.toThrow('The console connection closed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('a command too long for one packet is refused without costing the connection', async () => {
    server = await vanillaRcon('secret', (command) => `ran ${command.slice(0, 3)}`)
    const results = await rcon().runAll(target(server), [`say ${'x'.repeat(1443)}`, 'list'])
    expect(results[0]).toEqual({
      ok: false,
      error: 'Commands longer than 1446 bytes do not fit in one RCON packet',
    })
    expect(results[1]).toEqual({ ok: true, output: 'ran lis' })
  })
})
