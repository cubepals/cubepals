// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The status a deploy asks an edge for answers what the edge says, on its own listener. */
import { expect, test } from 'bun:test'
import { type Drain, drainOf, drainStatus } from './drain.ts'

test('answers the players connected and whether the routes are the newest', async () => {
  const state: Drain = { players: 3, routesCurrent: false, bedrock: 'unbound' }
  const server = drainStatus({ port: 0, hostname: '127.0.0.1', drain: () => ({ ...state }) })
  try {
    const at = `http://127.0.0.1:${server.port}/`
    expect(await (await fetch(at)).json()).toEqual({ players: 3, routesCurrent: false, bedrock: 'unbound' })
    state.players = 0
    state.routesCurrent = true
    state.bedrock = 'bound'
    expect(await (await fetch(at)).json()).toEqual({ players: 0, routesCurrent: true, bedrock: 'bound' })
  } finally {
    await server.stop(true)
  }
})

test('says Bedrock is unbound only while it is taken here and Geyser has not bound its port', () => {
  expect(drainOf(0, true, false).bedrock).toBe('none')
  expect(drainOf(0, true, true).bedrock).toBe('unbound')
  expect(drainOf(0, true, true, false).bedrock).toBe('unbound')
  expect(drainOf(0, true, true, true).bedrock).toBe('bound')
})
