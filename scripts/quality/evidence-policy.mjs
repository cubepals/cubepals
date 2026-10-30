// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The only optional suites: real-daemon scenarios run in fleet.yml against two live blocklyd nodes. */
export const liveFleet = new Set([
  'apps/control/src/infra/fleet/fleet-runtime.e2e.test.ts',
  'apps/control/src/infra/fleet/fleet-two-node.e2e.test.ts',
])
