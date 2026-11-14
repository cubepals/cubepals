// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The NetherNet client's way to the edge's signaling (`join.ts`): an HTTP door on this
 * machine's loopback that passes each request to `origin` and its answer back.
 *
 * A Bedrock app joining by address asks the name it was given over HTTPS on TCP 19132, where Fly
 * ends TLS with the play domain's certificate (infra/fly/edge.toml). The headless client signals
 * over plain HTTP to the host it is given, so it is given this door, and the door asks the edge
 * as the app does: over HTTPS, at the play name, with the same method, path and body.
 *
 * Not for the game itself, which goes over WebRTC straight to the address the edge's answer names,
 * or for what a test asks of the edge (`join.ts`).
 */

export interface SignalingForwarder {
  /** The loopback port the client signals to. */
  port: number
  close: () => void
}

/** The headers a signaling request or answer carries across: what its body is, and nothing else. */
const CARRIED = ['content-type']

const carried = (from: Headers): Headers => {
  const kept = new Headers()
  for (const name of CARRIED) {
    const value = from.get(name)
    if (value !== null) kept.set(name, value)
  }
  return kept
}

/**
 * Passes what reaches the returned loopback port to `origin` (`https://<name>:19132` for an edge),
 * each request as it came: its method, path, query and body. The answer comes back with its status
 * and body; one the edge never gave is a 502 that says why.
 */
export function signalingForwarder(origin: string): SignalingForwarder {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body =
        request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
      try {
        const answer = await fetch(`${origin}${url.pathname}${url.search}`, {
          method: request.method,
          headers: carried(request.headers),
          body,
          redirect: 'manual',
        })
        return new Response(await answer.arrayBuffer(), {
          status: answer.status,
          headers: carried(answer.headers),
        })
      } catch (error) {
        return new Response(`signaling at ${origin} was not reached: ${(error as Error).message}`, {
          status: 502,
        })
      }
    },
  })
  return {
    port: server.port ?? 0,
    close: () => {
      void server.stop(true)
    },
  }
}
