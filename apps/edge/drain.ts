// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a deploy asks of an edge before restarting it: how many players are connected through it,
 * and whether it holds the control plane's newest routes. Answered on a port of its own, bound to
 * the machine's private address (`fly-local-6pn`) and named by no service in infra/fly/edge.toml,
 * so only Fly's private network reaches it: the deploy asks through `fly proxy` to
 * `<machine>.vm.<app>.internal`. Never on the browsers' listener (browser-redirect.ts), which the
 * internet reaches. Not for the edge's health, which is Fly's check on that listener.
 */

/** What the edge says to a deploy. */
export interface Drain {
  players: number
  routesCurrent: boolean
  /** Whether Bedrock players are taken here ('none' where they aren't) and Geyser has bound its port. */
  bedrock: 'none' | 'bound' | 'unbound'
}

/** Listens on `port` of `hostname` and answers every request with `drain()` as JSON. */
export function drainStatus(options: {
  port: number
  hostname: string
  drain: () => Drain
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: options.port,
    hostname: options.hostname,
    fetch: () => Response.json(options.drain()),
  })
}

/**
 * Serves `drain` on DRAIN_PORT (8091) of DRAIN_HOST (`fly-local-6pn`). Where it can't listen the
 * edge carries on, and a deploy finds it can't count its players.
 */
export function serveDrain(drain: () => Drain): void {
  try {
    drainStatus({
      port: Number(process.env.DRAIN_PORT ?? '8091'),
      hostname: process.env.DRAIN_HOST ?? 'fly-local-6pn',
      drain,
    })
  } catch (error) {
    console.error('the drain status isn’t served; a deploy won’t wait for this edge’s players', error)
  }
}

/** What the edge says: Bedrock is 'unbound' while it is taken here (`taken`) and Geyser hasn't bound its port. */
export const drainOf = (players: number, routesCurrent: boolean, taken: boolean, bound?: boolean): Drain => ({
  players,
  routesCurrent,
  bedrock: !taken ? 'none' : bound ? 'bound' : 'unbound',
})
