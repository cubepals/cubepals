// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, timingSafeEqual } from 'node:crypto'
import { EDGE_PROTOCOL_BASE, IdleHint, SessionEvent, WakeRequest } from '@blockly/contracts/edge'
import { Hono } from 'hono'
import type { EdgeService } from '../../app/edge/service.ts'

/**
 * The edge protocol, served on the internal listener only. The edge asks for routes and reports
 * joins; everything it receives is already resolved.
 */
export function createInternalApp(deps: { edge: EdgeService; token: string }): Hono {
  const app = new Hono()
  const expected = Buffer.from(`Bearer ${deps.token}`)

  app.use(`${EDGE_PROTOCOL_BASE}/*`, async (c, next) => {
    const given = Buffer.from(c.req.header('authorization') ?? '')
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return c.json({ error: 'unauthorized' }, 401)
    await next()
  })

  app.get(`${EDGE_PROTOCOL_BASE}/routes`, async (c) => {
    const routes = await deps.edge.routes()
    const etag = `"${createHash('sha256').update(JSON.stringify(routes)).digest('hex').slice(0, 32)}"`
    if (c.req.header('if-none-match') === etag) return c.body(null, 304)
    c.header('ETag', etag)
    return c.json(routes)
  })

  app.post(`${EDGE_PROTOCOL_BASE}/wake`, async (c) => {
    const request = WakeRequest.safeParse(await c.req.json().catch(() => null))
    if (!request.success) return c.json({ error: 'bad request' }, 400)
    return c.json(await deps.edge.wake(request.data.hostname))
  })

  app.post(`${EDGE_PROTOCOL_BASE}/idle`, async (c) => {
    const hint = IdleHint.safeParse(await c.req.json().catch(() => null))
    if (!hint.success) return c.json({ error: 'bad request' }, 400)
    const decision = await deps.edge.idleHint(hint.data.hostname)
    console.warn(`edge idle hint for ${hint.data.hostname}: ${decision}`)
    return c.body(null, 204)
  })

  app.post(`${EDGE_PROTOCOL_BASE}/sessions`, async (c) => {
    const event = SessionEvent.safeParse(await c.req.json().catch(() => null))
    if (!event.success) return c.json({ error: 'bad request' }, 400)
    await deps.edge.recordSession(event.data)
    return c.body(null, 204)
  })

  return app
}
