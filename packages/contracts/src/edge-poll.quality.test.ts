// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A separately versioned v1 peer must understand route acknowledgement and the edge's advertised vocabulary. */
import { expect, test } from 'bun:test'
import { RoutesPoll } from '../../../apps/edge/poll.ts'
import {
  EDGE_ID_HEADER,
  EDGE_STARTED_HEADER,
  NEWER_OUTCOMES,
  NEWER_REASONS,
  ROUTES_HELD_HEADER,
  ROUTES_VERSION_HEADER,
} from './edge-poll.ts'

test('the route consumer reads the published response version and acknowledges it on the published wire', async () => {
  // A peer deployed earlier speaks the v1 names in docs/architecture.md, independent of this build's constants.
  const requests: Headers[] = []
  const before = Date.now()
  const poll = new RoutesPoll(
    async (headers) => {
      requests.push(new Headers({ ...headers, [EDGE_ID_HEADER]: 'edge-west' }))
      return Response.json({ routes: [] }, { headers: { 'x-routes-version': '123', etag: '"routes-123"' } })
    },
    async () => true,
  )
  expect(await poll.sync()).toBe(true)
  expect(poll.heldOnce()).toBe(true)
  expect(await poll.sync()).toBe(true)
  const first = requests[0]
  const second = requests[1]
  expect(first?.get('x-edge-id')).toBe('edge-west')
  expect(first?.has('x-routes-held')).toBe(false)
  expect(second?.get('x-routes-held')).toBe('123')
  expect(second?.get('if-none-match')).toBe('"routes-123"')
  const started = Number(first?.get('x-edge-started'))
  expect(started).toBeGreaterThan(0)
  expect(started).toBeLessThanOrEqual(before)
  expect(second?.get('x-edge-started')).toBe(String(started))
  // Reading incoming HTTP with the shared constants must still work against that independently deployed peer.
  const incoming = new Headers({
    'x-routes-held': '123',
    'x-routes-version': '124',
    'x-edge-started': String(started),
  })
  expect(incoming.get(ROUTES_HELD_HEADER)).toBe('123')
  expect(incoming.get(ROUTES_VERSION_HEADER)).toBe('124')
  expect(incoming.get(EDGE_STARTED_HEADER)).toBe(String(started))
})

test('advertised wake vocabulary names every newer v1 reply and all names are real schema alternatives', async () => {
  const { WakeRequest, WakeResult } = await import('./edge.ts')
  const request = WakeRequest.parse({
    hostname: 'maple.play.test',
    understands: [...NEWER_REASONS, ...NEWER_OUTCOMES],
  })
  expect(request.understands).toEqual(['failed', 'broken', 'asleep'])
  for (const reason of NEWER_REASONS) {
    const reply = { outcome: 'denied', reason } as const
    expect(WakeResult.parse(reply)).toEqual(reply)
  }
  for (const outcome of NEWER_OUTCOMES) expect(WakeResult.parse({ outcome })).toEqual({ outcome })
})
