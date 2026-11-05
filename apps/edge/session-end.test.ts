// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a session ended, watched on real connections through a relay like the front door's: a player
 * who goes quiet until the server closes (a drop the server times out), a player whose connection
 * resets, and what piles up toward a player who stops reading.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net'
import { watchSession } from './session-end.ts'

const closing: Array<Server | Socket> = []
afterEach(() => {
  for (const it of closing.splice(0)) 'destroy' in it ? it.destroy() : it.close()
})

const listening = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  )
const connected = (port: number) =>
  new Promise<Socket>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => resolve(socket))
    closing.push(socket)
  })
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A relay like the front door's: `player` is the far end the test plays the player from, `game`
 * the server's end; the watch sits on the relay's two sockets, as `front.ts` puts it.
 */
async function relayed() {
  let game!: Socket
  const gameServer = createServer((socket) => {
    game = socket
    closing.push(socket)
  })
  closing.push(gameServer)
  const gamePort = await listening(gameServer)
  let watch!: ReturnType<typeof watchSession>
  let front!: Socket
  const ends: Array<ReturnType<ReturnType<typeof watchSession>['end']>> = []
  const door = createServer((client) => {
    front = client
    closing.push(client)
    const toGame = connect({ host: '127.0.0.1', port: gamePort })
    closing.push(toGame)
    client.pipe(toGame).pipe(client)
    client.once('close', () => toGame.destroy())
    toGame.once('close', () => client.destroy())
    client.on('error', () => toGame.destroy())
    toGame.on('error', () => client.destroy())
    watch = watchSession(client, toGame)
    client.once('close', () => ends.push(watch.end()))
  })
  closing.push(door)
  const player = await connected(await listening(door))
  player.on('error', () => {})
  while (game === undefined || front === undefined) await wait(5)
  return { player, game: () => game, front: () => front, ends }
}

describe('how a session through the front door ended', () => {
  test('a player who went quiet until the server closed: the server first, with how long it was quiet', async () => {
    const { player, game, ends } = await relayed()
    player.write('hello')
    game().write('world')
    await wait(30)
    // The player sends nothing more; the server gives up on them.
    await wait(250)
    game().end()
    while (ends.length === 0) await wait(5)
    const [end] = ends
    expect(end).toMatchObject({ closedFirst: 'server', how: 'closed' })
    expect(end?.quietAtEndMs).toBeGreaterThanOrEqual(250)
    expect(end?.longestQuietMs).toBeGreaterThanOrEqual(250)
    expect(end?.downQuietAtEndMs).toBeGreaterThanOrEqual(200)
    expect(Date.parse(end?.longestQuietFrom ?? '')).toBeLessThan(Date.now())
  })

  test('a player whose connection reset: the player first, as a reset, quiet for no time at all', async () => {
    const { player, ends } = await relayed()
    player.write('hello')
    await wait(30)
    player.resetAndDestroy()
    while (ends.length === 0) await wait(5)
    const [end] = ends
    expect(end).toMatchObject({ closedFirst: 'player', how: 'reset' })
    expect(end?.error).toBe('ECONNRESET')
    expect(end?.quietAtEndMs).toBeLessThan(250)
  })

  test('a player who keeps sending has no long quiet, and what piles up toward one who stops reading is counted', async () => {
    const { player, game, ends } = await relayed()
    player.pause()
    const chunk = Buffer.alloc(256 * 1024, 1)
    for (let i = 0; i < 40; i++) {
      player.write('tick')
      game().write(chunk)
      await wait(5)
    }
    // Reading again lets what waited go out, so the relay can close.
    player.resume()
    game().end()
    while (ends.length === 0) await wait(5)
    const [end] = ends
    expect(end?.mostQueuedDown).toBeGreaterThan(0)
    expect(end?.longestQuietMs).toBeLessThan(200)
    expect(end?.stalls).toBe(0)
  })

  test('each silence of 5 s or more counts as a stall, the one a session ends in too', async () => {
    let now = 0
    const clock = { now: () => now, wall: () => 1_700_000_000_000 + now }
    const { EventEmitter } = await import('node:events')
    const player = Object.assign(new EventEmitter(), { writableLength: 0 }) as unknown as Socket
    const server = new EventEmitter() as unknown as Socket
    const watch = watchSession(player, server, clock)
    for (const at of [1_000, 7_000, 8_000, 14_500]) {
      now = at
      player.emit('data', Buffer.from('x'))
    }
    now = 40_000
    server.emit('end')
    expect(watch.end()).toMatchObject({
      stalls: 3,
      longestQuietMs: 25_500,
      longestQuietFrom: new Date(1_700_000_000_000 + 14_500).toISOString(),
      quietAtEndMs: 25_500,
      closedFirst: 'server',
      how: 'closed',
    })
  })
})
