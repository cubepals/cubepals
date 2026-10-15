// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server that reads as running is answered through the edge at once: the control plane's own
 * routes and view, the edge's poll and a real mc-router, with a stand-in game server behind it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Server } from 'node:net'
import { EDGE_PROTOCOL_BASE } from '@blockly/contracts/edge'
import { EDGE_ID_HEADER } from '@blockly/contracts/edge-poll'
import { createInternalApp } from '../control/src/interfaces/edge/internal.ts'
import { type Harness, hasDatabase, startHarness } from '../control/src/testing/harness.ts'
import { mappings } from './mappings.ts'
import { RoutesPoll } from './poll.ts'
import { RouterRoutes } from './router.ts'
import { answering, ping, ROUTER_BIN, type RunningRouter, startRouter } from './router-under-test.ts'

describe.skipIf(!hasDatabase || ROUTER_BIN === '')('a server that reads as running', () => {
  let h: Harness
  let router: RunningRouter
  let control: ReturnType<typeof Bun.serve>
  let polling = true
  let edge: Promise<void>
  const servers: Server[] = []

  beforeAll(async () => {
    h = await startHarness()
    router = await startRouter()
    const routes = new RouterRoutes(router.api)
    await routes.ready(10_000)
    control = Bun.serve({ port: 0, fetch: createInternalApp({ edge: h.app.edge, token: 'edge' }).fetch })
    // Every running server's route leads to the stand-in, and every other to a notice that isn't it.
    const server = await answering('the server itself', servers)
    const notice = await answering('a notice', servers)
    const poll = new RoutesPoll(
      (headers) =>
        fetch(`http://127.0.0.1:${control.port}${EDGE_PROTOCOL_BASE}/routes`, {
          headers: { ...headers, authorization: 'Bearer edge', [EDGE_ID_HEADER]: 'test-edge' },
        }),
      async (list) => {
        const here = list.map((r) => (r.state === undefined ? { ...r, destination: server } : r))
        await routes.apply(mappings(here, new Set(), { restarting: notice, asleep: notice }))
        return true
      },
    )
    // As the agent polls: once a second, and at once again after applying a list.
    edge = (async () => {
      while (polling) if (!(await poll.sync())) await Bun.sleep(1_000)
    })()
  }, 30_000)

  afterAll(async () => {
    polling = false
    await edge
    await control.stop()
    await router.stop()
    for (const server of servers) server.close()
    await h.close()
  })

  test('is answered through the edge the moment it does, and not before the edge holds its route', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    let heldBack = false
    for (;;) {
      const [shown, saved] = [await h.app.queries.get(owner, created.id), await h.server(created.id)]
      if (shown.status === 'running') break
      // Running, as Blockly knows it, while the edge doesn't route to it yet.
      if (saved.lifecycle.status === 'running') heldBack = true
      await Bun.sleep(10)
    }
    expect(await ping(router.port, `${created.slug}.play.test`)).toBe('the server itself')
    expect(heldBack).toBe(true)
  }, 30_000)
})
