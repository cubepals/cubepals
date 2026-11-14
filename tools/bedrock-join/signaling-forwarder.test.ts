// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test } from 'bun:test'
import { type SignalingForwarder, signalingForwarder } from './signaling-forwarder.ts'

const opened: { close: () => void }[] = []
afterEach(() => {
  for (const one of opened.splice(0)) one.close()
})

interface Heard {
  method: string
  path: string
  type: string | null
  body: string
}

/**
 * An edge's signaling, as a NetherNet server answers it: `GET /v1/join` says it speaks NetherNet,
 * `POST /v1/join/{networkId}` answers the offer with an answer. It remembers what it was asked.
 */
function edge(): { origin: string; heard: Heard[] } {
  const heard: Heard[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = await request.text()
      heard.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        type: request.headers.get('content-type'),
        body,
      })
      if (request.method === 'GET' && url.pathname === '/v1/join') return new Response('')
      if (request.method === 'POST' && url.pathname.startsWith('/v1/join/'))
        return new Response(`answer to ${body}`, { headers: { 'content-type': 'application/sdp' } })
      return new Response('no such signaling', { status: 404 })
    },
  })
  opened.push({ close: () => void server.stop(true) })
  return { origin: `http://127.0.0.1:${server.port}`, heard }
}

function through(origin: string): SignalingForwarder {
  const forwarding = signalingForwarder(origin)
  opened.push(forwarding)
  return forwarding
}

const at = (forwarding: SignalingForwarder, path: string) => `http://127.0.0.1:${forwarding.port}${path}`

test('a probe and an offer reach the edge as they were sent, and its answers come back', async () => {
  const far = edge()
  const forwarding = through(far.origin)
  const probe = await fetch(at(forwarding, '/v1/join'))
  expect(probe.status).toBe(200)
  expect(await probe.text()).toBe('')
  const offer = await fetch(at(forwarding, '/v1/join/1234567890123456789'), {
    method: 'POST',
    headers: { 'content-type': 'application/sdp' },
    body: 'v=0 offer',
  })
  expect(offer.status).toBe(200)
  expect(offer.headers.get('content-type')).toBe('application/sdp')
  expect(await offer.text()).toBe('answer to v=0 offer')
  expect(far.heard).toEqual([
    { method: 'GET', path: '/v1/join', type: null, body: '' },
    { method: 'POST', path: '/v1/join/1234567890123456789', type: 'application/sdp', body: 'v=0 offer' },
  ])
})

test("the edge's refusal comes back with its status and body", async () => {
  const far = edge()
  const forwarding = through(far.origin)
  const refused = await fetch(at(forwarding, '/v2/other?x=1'), { method: 'POST', body: 'x' })
  expect(refused.status).toBe(404)
  expect(await refused.text()).toBe('no such signaling')
  expect(far.heard.map((h) => h.path)).toEqual(['/v2/other?x=1'])
})

test('an edge that cannot be reached is a 502 that names where it was asked', async () => {
  const far = edge()
  const origin = far.origin
  for (const one of opened.splice(0)) one.close()
  const forwarding = through(origin)
  const answer = await fetch(at(forwarding, '/v1/join'))
  expect(answer.status).toBe(502)
  expect(await answer.text()).toContain(`signaling at ${origin} was not reached`)
})
