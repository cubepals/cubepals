// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edge asks the control plane about a pinged sleeping server once a while from each network,
 * and pings meanwhile hear that answer (`ping-wake.ts`).
 */
import { expect, test } from 'bun:test'
import { PingWakes } from './ping-wake.ts'

const EVERY_MS = 30_000
const PLAYER = '203.0.113.7'

test('a server pinged over and over is asked about once a while, and pings meanwhile hear the answer', async () => {
  let now = 0
  const asked: string[] = []
  const wakes = new PingWakes(
    async (hostname) => {
      asked.push(hostname)
      return hostname === 'castle.play.test'
    },
    EVERY_MS,
    () => now,
  )
  expect(wakes.waking('castle.play.test')).toBe(false)
  const [first, second] = [wakes.ask('castle.play.test', PLAYER), wakes.ask('castle.play.test', PLAYER)]
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  expect(wakes.waking('castle.play.test')).toBe(true)
  expect(await wakes.ask('meadow.play.test', PLAYER)).toBe(false)
  expect(wakes.waking('meadow.play.test')).toBe(false)
  expect(asked).toEqual(['castle.play.test', 'meadow.play.test'])

  // Once the while is over, the answer no longer stands, and the next ping asks again.
  now = EVERY_MS
  expect(wakes.waking('castle.play.test')).toBe(false)
  await wakes.ask('castle.play.test', PLAYER)
  expect(asked).toEqual(['castle.play.test', 'meadow.play.test', 'castle.play.test'])
})

test('an ask that fails says the server is not waking, and is not asked again within the while', async () => {
  let calls = 0
  const wakes = new PingWakes(
    async () => {
      calls++
      throw new Error('control plane unreachable')
    },
    EVERY_MS,
    () => 0,
  )
  expect(await wakes.ask('castle.play.test', PLAYER)).toBe(false)
  expect(await wakes.ask('castle.play.test', PLAYER)).toBe(false)
  expect(wakes.waking('castle.play.test')).toBe(false)
  expect(calls).toBe(1)
})

test('each network is asked for on its own: a stranger told no never stands in for a player', async () => {
  const asked: Array<string | null> = []
  const wakes = new PingWakes(
    async (_hostname, address) => {
      asked.push(address)
      return address === PLAYER
    },
    EVERY_MS,
    () => 0,
  )
  expect(await wakes.ask('castle.play.test', '198.51.100.9')).toBe(false)
  expect(wakes.waking('castle.play.test')).toBe(false)
  expect(await wakes.ask('castle.play.test', PLAYER)).toBe(true)
  // Every ping of a server waking hears so, whoever sent it.
  expect(wakes.waking('castle.play.test')).toBe(true)
  // A phone's IPv6 addresses change within one network, which is asked about once.
  await wakes.ask('castle.play.test', '2001:db8:1:2::a')
  await wakes.ask('castle.play.test', '2001:db8:1:2::b')
  await wakes.ask('castle.play.test', null)
  expect(asked).toEqual(['198.51.100.9', PLAYER, '2001:db8:1:2::a', null])
})
