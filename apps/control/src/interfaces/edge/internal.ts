// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  EDGE_PROTOCOL_BASE,
  IdleHint,
  PingWakeRequest,
  SessionEvent,
  WakeRequest,
  type WakeResult,
} from '@blockly/contracts/edge'
import {
  EDGE_ID_HEADER,
  EDGE_STARTED_HEADER,
  NEWER_REASONS,
  ROUTES_HELD_HEADER,
  ROUTES_VERSION_HEADER,
} from '@blockly/contracts/edge-poll'
import { VisitBatch } from '@blockly/contracts/join-records'
import { Hono } from 'hono'
import type { EdgeService } from '../../app/edge/service.ts'
import type { JoinService } from '../../app/joins/service.ts'
import { measured } from '../http/measured.ts'

/**
 * The edge protocol, served on the internal listener only. The edge asks for routes and reports
 * joins; everything it receives is already resolved.
 */
export function createInternalApp(deps: { edge: EdgeService; joins: JoinService; token: string }): Hono {
  const app = new Hono()
  // The operators' APIs, mounted on this listener later (main.node.ts), are measured here too.
  app.use('*', measured('internal'))
  const expected = Buffer.from(`Bearer ${deps.token}`)

  app.use(`${EDGE_PROTOCOL_BASE}/*`, async (c, next) => {
    const given = Buffer.from(c.req.header('authorization') ?? '')
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return c.json({ error: 'unauthorized' }, 401)
    await next()
  })

  app.get(`${EDGE_PROTOCOL_BASE}/routes`, async (c) => {
    const { routes, from, unrouted } = await deps.edge.listed()
    const etag = `"${createHash('sha256').update(JSON.stringify(routes)).digest('hex').slice(0, 32)}"`
    const unchanged = c.req.header('if-none-match') === etag
    // An edge that names itself is counted: the version it holds decides when a server reads as
    // running. Holding this very list, it holds this version; else the one it says, never later.
    const edgeId = c.req.header(EDGE_ID_HEADER)
    const said = Number(c.req.header(ROUTES_HELD_HEADER))
    const held = unchanged ? from : Number.isFinite(said) && said > 0 ? new Date(Math.min(said, +from)) : null
    const started = Number(c.req.header(EDGE_STARTED_HEADER))
    const startedAt = Number.isFinite(started) && started > 0 ? new Date(started) : null
    if (edgeId) await deps.edge.seen(edgeId, held, unrouted, startedAt)
    c.header(ROUTES_VERSION_HEADER, String(+from))
    if (unchanged) return c.body(null, 304)
    c.header('ETag', etag)
    return c.json(routes)
  })

  app.post(`${EDGE_PROTOCOL_BASE}/wake`, async (c) => {
    const request = WakeRequest.safeParse(await c.req.json().catch(() => null))
    if (!request.success) return c.json({ error: 'bad request' }, 400)
    const understands = request.data.understands ?? []
    const woken = await deps.edge.wake(
      request.data.hostname,
      understands.includes('failed'),
      request.data.name,
    )
    return c.json(forEdge(woken, understands))
  })

  app.post(`${EDGE_PROTOCOL_BASE}/ping-wake`, async (c) => {
    const request = PingWakeRequest.safeParse(await c.req.json().catch(() => null))
    if (!request.success) return c.json({ error: 'bad request' }, 400)
    return c.json(await deps.edge.pingWake(request.data.hostname, request.data.address))
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

  // Each connection the edge saw, in halves: written into its join's row (`app/joins/`).
  app.post(`${EDGE_PROTOCOL_BASE}/visits`, async (c) => {
    const batch = VisitBatch.safeParse(await c.req.json().catch(() => null))
    if (!batch.success) return c.json({ error: 'bad request' }, 400)
    await deps.joins.recordVisits(batch.data.reports)
    return c.body(null, 204)
  })

  return app
}

/**
 * A wake's answer in words the asking edge has. An edge from before a reason had words would turn
 * the player away with none, so it hears what it did then: a start that failed for good in waking
 * is still starting, and one that failed over what the server runs can't start right now, which is
 * how it words a suspended server. A server left asleep is still starting to it too.
 */
export function forEdge(woken: WakeResult, understands: readonly string[]): WakeResult {
  if (woken.outcome === 'asleep') return understands.includes(woken.outcome) ? woken : { outcome: 'starting' }
  if (woken.outcome !== 'denied' || !NEWER_REASONS.some((r) => r === woken.reason)) return woken
  if (understands.includes(woken.reason)) return woken
  return woken.reason === 'failed' ? { outcome: 'starting' } : { outcome: 'denied', reason: 'suspended' }
}
