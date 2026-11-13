// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What mc-router posts to its session webhook (`-webhook-url`) as it connects a player's
 * connection to a backend, and again as that connection ends; and what a `connect` event says
 * became of a join: connected to a backend, or closed with nothing said because none took it.
 *
 * Not for acting on one: the agent does (`agent.ts`).
 */

export interface RouterSession {
  event?: string
  timestamp?: string
  status?: string
  server?: string
  player?: { name?: string; uuid?: string }
  /** Where the client connected from: the front door's PROXY header, which mc-router trusts. */
  client?: { host?: string; port?: number }
  backend?: string
}

/**
 * The `status` of a `connect` event, as mc-router names each (`WebhookStatus` in its
 * `server/webhook_notifier.go`, at the release the edge's image pins); every other event says
 * `success`. It sends one `connect` event for a connection, or none: a join whose wake webhook
 * failed, or whose backend never took a connection after it, is closed without one.
 */
export const ROUTER_STATUS = {
  /** Its connection to the backend is made, and the join goes on to it. */
  connected: 'success',
  /**
   * It holds no backend for the hostname: no route names one, and the default route has none.
   * The event names no `backend`, and the join is closed with nothing said.
   */
  missingBackend: 'missing-backend',
  /** The backend it dialled didn't take the connection. The join is closed with nothing said. */
  failedBackendConnection: 'failed-backend-connection',
} as const

/**
 * Why the join of a `connect` event reached no backend, in the words a join turned away is
 * recorded with (`refused:…`, as `visits.ts` and the waiting room write them): mc-router's own
 * status, so a status it gains later is recorded as what it is. Null for a join it connected.
 */
export function droppedFor(event: RouterSession): string | null {
  if (event.status === undefined || event.status === ROUTER_STATUS.connected) return null
  return `refused:${event.status}`
}
