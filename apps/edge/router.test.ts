// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** mc-router's routes, one hostname at a time: what changes, and a real mc-router taking them. */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Server } from 'node:net'
import { changes, RouterRoutes } from './router.ts'
import { answering, ping, ROUTER_BIN, type RunningRouter, startRouter } from './router-under-test.ts'

test('only what differs changes: a new or moved hostname is set, one no longer wanted removed', () => {
  const held = new Map([
    ['a.play.test', '10.0.0.1:25565'],
    ['b.play.test', '10.0.0.2:25565'],
    ['c.play.test', '10.0.0.3:25565'],
  ])
  expect(
    changes(held, {
      'a.play.test': '10.0.0.1:25565',
      'b.play.test': '127.0.0.1:25563',
      'd.play.test': '10.0.0.4:25565',
    }),
  ).toEqual([
    { hostname: 'b.play.test', backend: '127.0.0.1:25563' },
    { hostname: 'd.play.test', backend: '10.0.0.4:25565' },
    { hostname: 'c.play.test', backend: null },
  ])
  expect(changes(held, Object.fromEntries(held))).toEqual([])
})

describe.skipIf(ROUTER_BIN === '')('a real mc-router', () => {
  let router: RunningRouter
  let routes: RouterRoutes
  const servers: Server[] = []

  beforeAll(async () => {
    router = await startRouter()
    routes = new RouterRoutes(router.api)
    await routes.ready(10_000)
  })

  afterAll(async () => {
    await router.stop()
    for (const server of servers) server.close()
  })

  test('a route applied is answered at once, and one removed is not', async () => {
    const server = await answering('the server itself', servers)
    await routes.apply({ 'first.play.test': server })
    expect(await ping(router.port, 'first.play.test')).toBe('the server itself')
    await routes.apply({})
    expect(await ping(router.port, 'first.play.test')).toBe('closed')
  })

  test('while hundreds of other routes change, a hostname that routes is answered every time', async () => {
    const steady = await answering('steady', servers)
    const other = await answering('other', servers)
    const table = (round: number): Record<string, string> => ({
      'steady.play.test': steady,
      ...Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [`s${i}.play.test`, round % 2 === i % 2 ? other : steady]),
      ),
    })
    await routes.apply(table(0))
    let changing = true
    const churn = (async () => {
      for (let round = 1; changing; round++) await routes.apply(table(round))
    })()
    const answers: string[] = []
    for (let i = 0; i < 200; i++) answers.push(await ping(router.port, 'steady.play.test'))
    changing = false
    await churn
    expect(answers.filter((answer) => answer !== 'steady')).toEqual([])
  }, 60_000)
})
