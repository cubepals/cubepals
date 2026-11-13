// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What mc-router posts to its session webhook (`-webhook-url`) as it connects a player's
 * connection to a backend, and again as that connection ends.
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
