// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What an open realtime session may keep doing, through the real transport: how many consoles it
 * follows and opens, and what happens once the sign-in it came from has ended, or its account may
 * no longer watch a console it follows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer as listenOn } from 'node:net'
import { type RealtimeMap, realtimeContract } from '@blockly/contracts/realtime'
import { Client } from 'transport-io'
import { connectWebSocket } from 'transport-io/websocket-transport'
import { ConsoleFeed } from '../../app/console/feed.ts'
import type { EventBus } from '../../app/ports/events.ts'
import type { RealtimeTickets, TicketHolder } from '../../app/ports/tickets.ts'
import { installTuning, tuning } from '../../app/tuning.ts'
import { MemoryLimits } from '../../infra/limits/memory-limits.ts'
import { mintPinnedCertificate } from '../../infra/realtime/pinned-certificate.ts'
import { startRealtime } from './server.node.ts'

const ORIGIN = 'https://web.test'
const RECHECK_MS = 200
const [ONE, TWO, THREE, SLOW, BROKEN] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = listenOn().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

/** A browser signed in as `userId`, and the consoles whose history it has been sent. */
async function browser(port: number, userId: string) {
  const client = new Client<RealtimeMap>({
    contract: realtimeContract,
    connect: () => connectWebSocket({ url: `ws://127.0.0.1:${port}/transport-io?ticket=${userId}` }),
  })
  const histories: string[] = []
  client.on('consoleHistory', ({ serverId }) => histories.push(serverId))
  const connected = new Promise<void>((resolve) =>
    client.onSession((state) => state.status === 'connected' && resolve()),
  )
  await client.connect()
  await connected
  const watch = (serverId: string) => client.emit('watch', { serverId, topic: 'console' })
  const unwatch = (serverId: string) => client.emit('unwatch', { serverId, topic: 'console' })
  return { client, histories, watch, unwatch }
}

const was = tuning()
let realtime: { stop(): Promise<void> }
let fallbackPort: number
const NativeWebSocket = globalThis.WebSocket
/** Accounts whose sign-in has ended, and consoles (`user:server`) an account may no longer watch. */
const signedOut = new Set<string>()
const barred = new Set<string>()

beforeAll(async () => {
  installTuning({ ...was, abuse: { ...was.abuse, consolesPerConnection: 2, consoleWatchesPerMinute: 5 } })
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, { headers: { Origin: ORIGIN }, ...(protocols ? { protocols } : {}) } as never)
    }
  } as typeof WebSocket
  const cert = await mintPinnedCertificate('127.0.0.1')
  fallbackPort = await freePort()
  const events: EventBus = { publish: async () => {}, subscribe: async () => async () => {} }
  // Each test signs in as its own account: the ticket is the account's id.
  const tickets: RealtimeTickets = {
    issue: async ({ userId }) => userId,
    verify: async (ticket) => ({ userId: ticket, sessionId: `session-${ticket}` }),
  }
  // The feed's own count of consoles opened, beside made-up answers for what the database holds.
  const counted = new ConsoleFeed(null as never, null as never, [], new MemoryLimits())
  const feed = {
    canWatch: async (userId: string, serverId: string) => {
      // SLOW's answer takes a moment, so a session's next message arrives while it is asked.
      if (serverId === SLOW) await Bun.sleep(150)
      // BROKEN's answer fails, as a database that doesn't answer does.
      if (serverId === BROKEN) throw new Error('the database did not answer')
      return !barred.has(`${userId}:${serverId}`)
    },
    stillSignedIn: async ({ userId, sessionId }: TicketHolder) =>
      sessionId === `session-${userId}` && !signedOut.has(userId),
    mayOpen: (userId: string) => counted.mayOpen(userId),
    recent: async () => [],
    tail: async function* () {},
  } as unknown as ConsoleFeed
  realtime = await startRealtime({
    listen: { host: '127.0.0.1', port: await freePort() },
    fallbackListen: { host: '127.0.0.1', port: fallbackPort },
    tls: { cert: cert.cert, privKey: cert.privKey },
    allowedOrigins: [ORIGIN],
    events,
    tickets,
    console: feed,
    presence: async () => [],
    recheckMs: RECHECK_MS,
  })
})

afterAll(async () => {
  installTuning(was)
  globalThis.WebSocket = NativeWebSocket
  await realtime?.stop()
})

describe('an open realtime session, as it follows consoles', () => {
  test('follows only so many consoles at once', async () => {
    const { client, histories, watch, unwatch } = await browser(fallbackPort, 'user-a')
    watch(ONE)
    watch(TWO)
    watch(THREE)
    await Bun.sleep(300)
    expect(histories.sort()).toEqual([ONE, TWO].sort())
    // Leaving one makes room for another.
    unwatch(ONE)
    await Bun.sleep(100)
    watch(THREE)
    await Bun.sleep(300)
    expect(histories.sort()).toEqual([ONE, TWO, THREE].sort())
    client.disconnect()
  }, 20_000)

  test('a console left while it is still being let in is not opened', async () => {
    const { client, histories, watch, unwatch } = await browser(fallbackPort, 'user-f')
    watch(SLOW)
    await Bun.sleep(50)
    unwatch(SLOW)
    await Bun.sleep(400)
    expect(histories).toEqual([])
    client.disconnect()
  }, 20_000)

  test('a console that fails to open gives its place back', async () => {
    const { client, histories, watch } = await browser(fallbackPort, 'user-g')
    watch(BROKEN)
    await Bun.sleep(200)
    watch(ONE)
    watch(TWO)
    await Bun.sleep(300)
    expect(histories.sort()).toEqual([ONE, TWO].sort())
    client.disconnect()
  }, 20_000)

  test('a console already open stays open when its account has opened its share this minute', async () => {
    const { client, histories, watch } = await browser(fallbackPort, 'user-h')
    for (let i = 0; i < 6; i++) watch(ONE)
    await Bun.sleep(400)
    expect(histories.length).toBe(5)
    expect([...client.getSnapshot().rooms]).toContain(`console:${ONE}`)
    client.disconnect()
  }, 20_000)

  test('opens only so many consoles a minute for one account, across its browsers', async () => {
    const one = await browser(fallbackPort, 'user-b')
    const two = await browser(fallbackPort, 'user-b')
    for (let i = 0; i < 3; i++) one.watch(ONE)
    for (let i = 0; i < 3; i++) two.watch(ONE)
    await Bun.sleep(400)
    expect(one.histories.length + two.histories.length).toBe(5)
    one.client.disconnect()
    two.client.disconnect()
  }, 20_000)
})

describe('an open realtime session, once its sign-in or its access ends', () => {
  test('is closed at its next watch once its sign-in has ended', async () => {
    const { client, histories, watch } = await browser(fallbackPort, 'user-c')
    signedOut.add('user-c')
    watch(ONE)
    await Bun.sleep(300)
    expect(histories).toEqual([])
    expect(client.getSnapshot().status).toBe('closed')
    expect(client.getSnapshot().refused?.reason).toBe('signed out')
  }, 20_000)

  test('is closed within a recheck once its sign-in has ended', async () => {
    const { client } = await browser(fallbackPort, 'user-d')
    signedOut.add('user-d')
    await Bun.sleep(RECHECK_MS * 3)
    expect(client.getSnapshot().status).toBe('closed')
  }, 20_000)

  test('leaves a console its account may no longer watch, and keeps the rest', async () => {
    const { client, watch } = await browser(fallbackPort, 'user-e')
    watch(ONE)
    watch(TWO)
    await Bun.sleep(300)
    const rooms = () => [...client.getSnapshot().rooms].sort()
    expect(rooms()).toEqual([`console:${ONE}`, `console:${TWO}`, 'user:user-e'].sort())
    barred.add(`user-e:${ONE}`)
    await Bun.sleep(RECHECK_MS * 3)
    expect(rooms()).toEqual([`console:${TWO}`, 'user:user-e'])
    expect(client.getSnapshot().status).toBe('connected')
    client.disconnect()
  }, 20_000)
})
