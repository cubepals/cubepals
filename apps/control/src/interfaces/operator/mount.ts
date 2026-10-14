// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono'
import type { ControlPlane } from '../../app/control-plane.ts'
import type { ModerationService } from '../../app/moderation/service.ts'
import type { PlatformHealth } from '../../app/platform/health.ts'
import type { SuspendSwitch } from '../../app/platform/suspend-switch.ts'
import { createOpsApi } from './ops.ts'
import { createRuntimesApi } from './runtimes.ts'

/**
 * The operators' APIs main.node.ts mounts on the internal listener when OPERATOR_TOKEN is set,
 * each under its own base and behind the same token: where servers run (`runtimes.ts`, under
 * `/runtimes/v1`) and accounts, their servers and production's health (`ops.ts`, under
 * `/ops/v1`). The fleet's own operator API is mounted with the fleet, since only a deployment that
 * runs one has it. `api` is what the web's API is given beside the control plane, the same objects.
 */
export function operatorApis(
  app: ControlPlane,
  api: { health: PlatformHealth; flySuspend: SuspendSwitch; moderation: ModerationService },
  token: string,
): Hono {
  const apis = new Hono()
  apis.route('/', createRuntimesApi({ placement: app.placement, economics: app.economics, token }))
  apis.route(
    '/',
    createOpsApi({
      ...app,
      // Only these: the API's other services share names with the control plane's (`platform`).
      health: api.health,
      flySuspend: api.flySuspend,
      moderation: api.moderation,
      upkeep: app.servers.upkeep,
      token,
    }),
  )
  return apis
}
