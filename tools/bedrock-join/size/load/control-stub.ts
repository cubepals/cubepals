// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stand-in control plane for a sizing edge (size.ts): the edge's routes and wake, from memory,
 * pointing at the Java server on this machine. `a.play.bsize` is running. `b.play.bsize` is asleep
 * until a join asks for it, and answers "starting" for WAKE_MS before "ready", as a server coming up.
 */

import { createHash } from 'node:crypto'

const SERVER = `${process.env.FLY_MACHINE_ID}.vm.${process.env.FLY_APP_NAME}.internal:25570`
const WAKE_MS = Number(process.env.WAKE_MS ?? 15_000)
let wakeStarted = 0

function routes() {
  const awake = wakeStarted > 0 && Date.now() - wakeStarted >= WAKE_MS
  return {
    routes: [
      { hostname: 'a.play.bsize', destination: SERVER },
      {
        hostname: 'b.play.bsize',
        destination: SERVER,
        ...(awake ? {} : { state: 'asleep' as const, ...(wakeStarted > 0 ? { waking: true as const } : {}) }),
      },
    ],
  }
}

Bun.serve({
  hostname: '::',
  port: 4001,
  async fetch(request) {
    const path = new URL(request.url).pathname.replace('/edge/v1', '')
    if (path === '/routes') {
      const body = JSON.stringify(routes())
      const etag = `"${createHash('sha1').update(body).digest('hex')}"`
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304 })
      return new Response(body, {
        headers: { 'content-type': 'application/json', etag, 'x-routes-version': String(Date.now()) },
      })
    }
    if (path === '/wake') {
      const { hostname } = (await request.json()) as { hostname: string }
      if (hostname === 'b.play.bsize') {
        if (wakeStarted === 0) wakeStarted = Date.now()
        if (Date.now() - wakeStarted < WAKE_MS) return Response.json({ outcome: 'starting' })
      }
      return Response.json({ outcome: 'ready', destination: SERVER })
    }
    if (path === '/ping-wake') return Response.json({ waking: false })
    return new Response(null, { status: 204 })
  },
})
process.stderr.write(`[control-stub] routes point at ${SERVER}\n`)
