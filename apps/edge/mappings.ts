// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// Where mc-router sends each hostname, from what the control plane says about its server.

import type { EdgeRoutes } from '@blockly/contracts/edge'

/**
 * mc-router's mappings for `routes`. A running server's hostname goes to the server, or to the
 * restarting notice while it doesn't answer (its destination is in `unreachable`). A restarting
 * one's goes to the restarting notice, and a sleeping one's to the sleeping notice, which answers
 * its ping. Its destination would be dialled for the ping instead, and on Fly that dial succeeds
 * even while the machine is stopped, so the ping would never be answered.
 */
export function mappings(
  routes: EdgeRoutes['routes'],
  unreachable: ReadonlySet<string>,
  notices: { restarting: string; asleep: string },
): Record<string, string> {
  return Object.fromEntries(
    routes.map((r) => [
      r.hostname,
      r.state === 'asleep'
        ? notices.asleep
        : r.state === 'restarting' || unreachable.has(r.destination)
          ? notices.restarting
          : r.destination,
    ]),
  )
}
