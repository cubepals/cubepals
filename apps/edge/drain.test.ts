// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The status a deploy asks an edge for answers what the edge says, on its own listener. */
import { expect, test } from 'bun:test'
import { drainStatus } from './drain.ts'

test('answers the players connected and whether the routes are the newest', async () => {
  const state = { players: 3, routesCurrent: false }
  const server = drainStatus({ port: 0, hostname: '127.0.0.1', drain: () => ({ ...state }) })
  try {
    const at = `http://127.0.0.1:${server.port}/`
    expect(await (await fetch(at)).json()).toEqual({ players: 3, routesCurrent: false })
    state.players = 0
    state.routesCurrent = true
    expect(await (await fetch(at)).json()).toEqual({ players: 0, routesCurrent: true })
  } finally {
    await server.stop(true)
  }
})
