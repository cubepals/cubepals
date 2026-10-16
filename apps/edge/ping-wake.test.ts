// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { PingWakes } from './ping-wake.ts'

const EVERY_MS = 30_000

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
  const [first, second] = [wakes.ask('castle.play.test'), wakes.ask('castle.play.test')]
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  expect(wakes.waking('castle.play.test')).toBe(true)
  expect(await wakes.ask('meadow.play.test')).toBe(false)
  expect(wakes.waking('meadow.play.test')).toBe(false)
  expect(asked).toEqual(['castle.play.test', 'meadow.play.test'])

  // Once the while is over, the answer no longer stands, and the next ping asks again.
  now = EVERY_MS
  expect(wakes.waking('castle.play.test')).toBe(false)
  await wakes.ask('castle.play.test')
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
  expect(await wakes.ask('castle.play.test')).toBe(false)
  expect(await wakes.ask('castle.play.test')).toBe(false)
  expect(wakes.waking('castle.play.test')).toBe(false)
  expect(calls).toBe(1)
})
