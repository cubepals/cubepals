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
import { EDGE_BEHIND_MS } from '../control/src/app/edge/routed.ts'
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
  /** Done before each time the edge asks: a test's way to change the routes under it. */
  let beforeAsking = async () => {}

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
      async (headers) => {
        await beforeAsking()
        return fetch(`http://127.0.0.1:${control.port}${EDGE_PROTOCOL_BASE}/routes`, {
          headers: { ...headers, authorization: 'Bearer edge', [EDGE_ID_HEADER]: 'test-edge' },
        })
      },
      async (list) => {
        const here = list.routes.map((r) => (r.state === undefined ? { ...r, destination: server } : r))
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

  /**
   * Makes a server and pings it through the edge the moment its view says running; what the edge
   * answered, whether it was running in Blockly's own record first, and for how long.
   */
  async function joinedOnceRunning() {
    const owner = await h.user()
    const created = await h.create(owner)
    let runningSince: number | null = null
    for (;;) {
      const [shown, saved] = [await h.app.queries.get(owner, created.id), await h.server(created.id)]
      if (shown.status === 'running') break
      // Running, as Blockly knows it, while the edge doesn't route to it yet.
      if (saved.lifecycle.status === 'running') runningSince ??= Date.now()
      await Bun.sleep(10)
    }
    const heldMs = runningSince === null ? null : Date.now() - runningSince
    return { answer: await ping(router.port, `${created.slug}.play.test`), heldMs }
  }

  test('is answered through the edge the moment it does, and not before the edge holds its route', async () => {
    const { answer, heldMs } = await joinedOnceRunning()
    expect(answer).toBe('the server itself')
    expect(heldMs).not.toBeNull()
  }, 30_000)

  test('while the routes change all the time, it still reads as running as soon as the edge holds it', async () => {
    // Another server's owner changes its address every time before the edge asks, so no two
    // lists the edge is handed are the same.
    const otherOwner = await h.user()
    const other = await h.create(otherOwner)
    await h.until(other.id, 'running')
    await h.settled(other.id)
    let renamed = 0
    beforeAsking = async () => {
      await h.app.servers.changeAddress(otherOwner, other.id, `churn-${renamed++}`)
    }
    try {
      const { answer, heldMs } = await joinedOnceRunning()
      expect(answer).toBe('the server itself')
      // Held by the edge's own word, well before the longest any server waits.
      expect(heldMs).not.toBeNull()
      expect(heldMs ?? EDGE_BEHIND_MS).toBeLessThan(EDGE_BEHIND_MS / 2)
    } finally {
      beforeAsking = async () => {}
    }
  }, 30_000)
})
