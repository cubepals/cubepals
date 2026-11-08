// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operator's notice in the multiplayer list: a running server's own answer to a ping gets the
 * notice as its message on its way through the front door, keeping everything else it said, however
 * the answer is cut into chunks; an answer that isn't a status goes on as it came; only a running
 * server's route with a notice is rewritten; and a sleeping server shows the notice in its own
 * message's place.
 */
import { afterEach, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Server } from 'node:net'
import type { EdgeRoute } from '@blockly/contracts/edge'
import { asleepMessage, LIST_WIDTH, noticedMessage, width } from './asleep.ts'
import { front } from './front.ts'
import { Gate } from './limits.ts'
import { packet, readVarInt, statusRequest, string } from './notice.ts'
import { runningNotice, StatusRewrite, withNotice } from './ping-notice.ts'

const NOTICE = '§cUnder review'
const ANSWER = {
  version: { name: '1.21.4', protocol: 769 },
  players: { max: 10, online: 3 },
  description: { text: 'Our own message' },
  favicon: 'data:image/png;base64,AAAA',
}
const status = (answer: unknown = ANSWER) => packet(0, string(JSON.stringify(answer)))

/** The status a packet holds. */
function read(bytes: Uint8Array): unknown {
  const length = readVarInt(bytes, 0)
  const id = length && readVarInt(bytes, length.next)
  const size = id && readVarInt(bytes, id.next)
  if (!size) throw new Error('Not a packet')
  return JSON.parse(new TextDecoder().decode(bytes.subarray(size.next, size.next + size.value)))
}

test('a status gets the notice as its message, and keeps the rest of what the server said', () => {
  expect(read(withNotice(status(), NOTICE) ?? new Uint8Array())).toEqual({
    ...ANSWER,
    description: { text: NOTICE },
  })
  // What isn't a whole status answer is left alone.
  expect(withNotice(packet(1, [0, 0, 0, 0, 0, 0, 0, 1]), NOTICE)).toBeNull()
  expect(withNotice(packet(0, string('not json')), NOTICE)).toBeNull()
  expect(withNotice(packet(0, string('[1]')), NOTICE)).toBeNull()
  expect(withNotice(status().subarray(0, 20), NOTICE)).toBeNull()
})

test('the answer is held until its status is whole, however it is cut, and the pong passes after', () => {
  const pong = packet(1, [0, 0, 0, 0, 0, 0, 0, 7])
  const whole = Uint8Array.from([...status(), ...pong])
  for (const cut of [1, 2, 7, 40, whole.length - pong.length, whole.length - 1]) {
    const rewrite = new StatusRewrite(NOTICE)
    const first = rewrite.take(whole.subarray(0, cut))
    const rest = rewrite.take(whole.subarray(cut))
    const out = Uint8Array.from([...first, ...rest, ...rewrite.flush()])
    expect(read(out)).toMatchObject({ description: { text: NOTICE }, players: ANSWER.players })
    expect([...out.subarray(out.length - pong.length)]).toEqual([...pong])
  }
})

test('an answer that isn’t a status goes on as it came, and so does a server that ends early', () => {
  const odd = new StatusRewrite(NOTICE)
  const legacy = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x00])
  expect([...odd.take(legacy)]).toEqual([...legacy])
  expect([...odd.take(Uint8Array.from([1, 2]))]).toEqual([1, 2])
  const early = new StatusRewrite(NOTICE)
  const part = status().subarray(0, 10)
  expect(early.take(part)).toHaveLength(0)
  expect([...early.flush()]).toEqual([...part])
})

test('only a running server’s route with a notice is rewritten', () => {
  const route: EdgeRoute = { hostname: 'cove.play.test', destination: '10.0.0.1:25565' }
  expect(runningNotice({ ...route, notice: NOTICE })).toBeInstanceOf(StatusRewrite)
  expect(runningNotice(route)).toBeNull()
  // A sleeping or restarting one's answer is the agent's own, which says it itself.
  expect(runningNotice({ ...route, notice: NOTICE, state: 'asleep' })).toBeNull()
  expect(runningNotice({ ...route, notice: NOTICE, state: 'restarting' })).toBeNull()
  expect(runningNotice(undefined)).toBeNull()
})

test('a sleeping server shows the notice in its own message’s place, and whole', () => {
  expect(noticedMessage(NOTICE, 'Sleeping')).toBe(asleepMessage(NOTICE, 'Sleeping'))
  expect(noticedMessage(NOTICE, 'Sleeping')).toBe(`${NOTICE}\n§r§7Sleeping`)
  // One that takes both lines shows alone, never cut.
  const long = 'This server’s account is under review, and it will stop running soon'
  expect(width(long)).toBeGreaterThan(LIST_WIDTH)
  expect(noticedMessage(long, 'Sleeping')).toBe(long)
})

const open: Server[] = []
afterEach(() => {
  for (const server of open.splice(0)) server.close()
})
const listening = (server: Server) =>
  new Promise<number>((resolve) =>
    server.once('listening', () => resolve((server.address() as AddressInfo).port)),
  )

/** A stand-in for mc-router and a running server behind it: answers a ping in two writes, then closes. */
async function answering(): Promise<number> {
  const server = createServer((socket) => {
    socket.once('data', () => {
      const answer = status()
      socket.write(answer.subarray(0, 5))
      setTimeout(() => socket.end(answer.subarray(5)), 20)
    })
    socket.on('error', () => undefined)
  }).listen(0, '127.0.0.1')
  open.push(server)
  return listening(server)
}

/** Pings the front door, and resolves with everything it answered. */
function ping(port: number, hostname: string): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(statusRequest(hostname, 25565)))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => resolve(new Uint8Array(Buffer.concat(chunks))))
  })
}

test('a ping to a running server through the front door shows its owner’s notice', async () => {
  const listener = front({
    port: 0,
    router: await answering(),
    proxied: false,
    gate: new Gate({
      address: { connections: { perSecond: 100, burst: 100 }, greeting: 100, open: 100 },
      server: { connections: { perSecond: 100, burst: 100 }, open: 100 },
    }),
    known: (hostname) => hostname.endsWith('.play.test'),
    plain: () => true,
    busy: 'Busy',
    refuse: () => null,
    timeouts: { connectMs: 1_000, idleMs: 60_000 },
    notice: (hostname) => (hostname === 'noticed.play.test' ? new StatusRewrite(NOTICE) : null),
  })
  open.push(listener)
  const port = await listening(listener)
  expect(read(await ping(port, 'noticed.play.test'))).toEqual({ ...ANSWER, description: { text: NOTICE } })
  expect(read(await ping(port, 'other.play.test'))).toEqual(ANSWER)
})
