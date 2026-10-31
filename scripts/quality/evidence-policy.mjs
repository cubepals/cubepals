// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Optional in ordinary shards; applicable CI requires both live suites through reusable fleet.yml. */
export const liveFleet = new Set([
  'apps/control/src/infra/fleet/fleet-runtime.e2e.test.ts',
  'apps/control/src/infra/fleet/fleet-two-node.e2e.test.ts',
])
