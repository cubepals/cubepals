// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the control plane counts and times as it runs, for whatever serves it to a monitor
 * (`infra/metrics/`). Every label is one of a few fixed words: never a server, player or address.
 */
export interface Telemetry {
  /** An operation ended: how long it took since it was queued. */
  operationEnded(kind: string, outcome: 'succeeded' | 'failed' | 'cancelled', ms: number): void
  /** An operation failed for good, at the step it had reached (`none` before its first). */
  operationFailed(kind: string, step: string | null): void
  /** A player was in the world: `path` is how the edge took them (`direct`, `held`; null if unsaid). */
  joinCompleted(path: string | null, edgeRegion: string | null, ms: number): void
  /** A server the edge asked to wake was ready. */
  wakeCompleted(edgeRegion: string | null, ms: number): void
  /** The edge's ask to wake a server was answered: `reason` is a refusal's, or what a start waits behind. */
  wakeAnswered(outcome: string, reason: string | null): void
  /**
   * An HTTP listener (`api`, `internal`, `worker`) answered a request: `route` is the template it
   * matched (`*` when none did), never the path it was asked for.
   */
  requestServed(listener: string, route: string, method: string, status: number, ms: number): void
  /** A tRPC procedure ran: its path as the router defines it, and the HTTP status it answered with. */
  procedureServed(procedure: string, status: number, ms: number): void
  /** A browser asked the realtime role to connect: `outcome` is `accepted`, or why it was refused. */
  realtimeConnected(transport: 'webtransport' | 'websocket', outcome: string, ms: number): void
  /** The realtime role's open connections, read as the monitor scrapes. */
  observeRealtime(read: () => { browsers: number; tails: number }): void
}
