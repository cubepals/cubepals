// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' example address at the edge: what the sleeping notice tells the server list and a join
 * there, as the agent asks it (`exampleAt`, then the sleeping server's own text), and, with a real
 * mc-router, that a ping reaches it while an address nobody has goes unanswered.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type AddressInfo, createServer, type Server } from 'node:net'
import { EXAMPLE, exampleAt } from './example-address.ts'
import { mappings } from './mappings.ts'
import { Notice, type NoticeText, packet, readVarInt, string, varInt } from './notice.ts'
import { RouterRoutes } from './router.ts'
import { ping, ROUTER_BIN, type RunningRouter, startRouter } from './router-under-test.ts'

const ASLEEP: NoticeText = { status: 'Sleeping · join to wake it up', join: null }

/** The sleeping notice as the agent builds it, with the hostnames the routes name. */
const sleepingNotice = (known: ReadonlySet<string>) =>
  new Notice((dialled) => exampleAt(dialled, known) ?? ASLEEP)

/** A 1.21 client's handshake for `address`: a status request (1) or a join (2). */
const handshake = (address: string, intent: number) =>
  packet(0, [...varInt(767), ...string(address), 0x63, 0xdd, intent])

/** The first string field of the packet that opens `bytes`, as a client reads it. */
function firstString(bytes: Uint8Array | undefined): string {
  const all = bytes ?? new Uint8Array()
  const length = readVarInt(all, 0)
  const id = length && readVarInt(all, length.next)
  const size = id && readVarInt(all, id.next)
  if (!size) throw new Error('not a packet with a string')
  return new TextDecoder().decode(all.subarray(size.next, size.next + size.value))
}

/** What the server list is shown for `address`. */
function statusAt(address: string, known: ReadonlySet<string> = new Set()): string {
  const notice = sleepingNotice(known)
  notice.receive(handshake(address, 1))
  return JSON.parse(firstString(notice.receive(packet(0, [])).reply[0])).description.text
}

test('the server list is told it is an example, and where to make a server of your own', () => {
  expect(statusAt('your-server.play.cubepals.test')).toBe(
    'Just an example address\nMake your own at cubepals.com',
  )
  // As mc-router reads a hostname: any case, and a final dot.
  expect(statusAt('Your-Server.Play.Cubepals.Test.')).toBe(EXAMPLE.status)
})

test('a join is told it found the example, and where to make a server of its own', () => {
  const answer = sleepingNotice(new Set()).receive(handshake('your-server.play.cubepals.test', 2))
  expect(answer.close).toBe(true)
  expect(answer.join).toBeUndefined()
  expect(JSON.parse(firstString(answer.reply[0]))).toEqual({
    text: 'You found our example address. Make a server of your own at cubepals.com and send your friends its address.',
  })
})

test('a server whose route names the address, and any other address, are told what they always were', () => {
  const known = new Set(['your-server.play.cubepals.test'])
  expect(statusAt('your-server.play.cubepals.test', known)).toBe(ASLEEP.status)
  expect(exampleAt('your-server.play.cubepals.test', known)).toBeNull()
  for (const address of [
    'your-server-2.play.cubepals.test',
    'lobby.play.cubepals.test',
    'play.cubepals.test',
  ])
    expect(exampleAt(address, new Set())).toBeNull()
  // A join at a sleeping server is still handed to the waiting room.
  const join = sleepingNotice(new Set()).receive(handshake('lobby.play.cubepals.test', 2))
  expect(join.join?.address).toBe('lobby.play.cubepals.test')
})

test('mc-router sends the example under every play domain to the sleeping notice, unless a route names it', () => {
  const notices = { restarting: '127.0.0.1:25564', asleep: '127.0.0.1:25563' }
  expect(mappings([], new Set(), notices, ['play.cubepals.test', 'MC.Cubepals.Test'])).toEqual({
    'your-server.play.cubepals.test': notices.asleep,
    'your-server.mc.cubepals.test': notices.asleep,
  })
  const own = [{ hostname: 'your-server.play.cubepals.test', destination: 'bly-a.flycast:25565' }]
  expect(mappings(own, new Set(), notices, ['play.cubepals.test'])).toEqual({
    'your-server.play.cubepals.test': 'bly-a.flycast:25565',
  })
})

describe.skipIf(ROUTER_BIN === '')('a real mc-router', () => {
  let router: RunningRouter
  let routes: RouterRoutes
  let notice: Server

  beforeAll(async () => {
    router = await startRouter()
    // As the edge runs it: an address no route names goes to the default route, with no backend.
    routes = new RouterRoutes(router.api)
    await routes.ready(10_000)
    notice = createServer((socket) => {
      const talk = sleepingNotice(new Set())
      socket.on('error', () => socket.destroy())
      socket.on('data', (chunk) => {
        const { reply, close } = talk.receive(chunk)
        for (const bytes of reply) socket.write(bytes)
        if (close) socket.end()
      })
    }).listen(0, '127.0.0.1')
    await new Promise((resolve) => notice.once('listening', resolve))
  })

  afterAll(async () => {
    notice.close()
    await router.stop()
  })

  test('a ping at the example is answered, and one at an address nobody has is not', async () => {
    const asleep = `127.0.0.1:${(notice.address() as AddressInfo).port}`
    const notices = { restarting: asleep, asleep }
    await routes.apply(mappings([], new Set(), notices, ['play.test']))
    expect(await ping(router.port, 'your-server.play.test')).toBe(EXAMPLE.status)
    expect(await ping(router.port, 'nobody.play.test')).toBe('closed')
  })
})
