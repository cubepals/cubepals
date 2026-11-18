// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono'
import { OperatorConsoleWatch } from '../../app/console/operator-watch.ts'
import type { ControlPlane } from '../../app/control-plane.ts'
import type { ModerationService } from '../../app/moderation/service.ts'
import type { PlatformHealth } from '../../app/platform/health.ts'
import type { SuspendSwitch } from '../../app/platform/suspend-switch.ts'
import type { RealtimeTickets } from '../../app/ports/tickets.ts'
import { createOpsApi } from './ops.ts'
import { createRuntimesApi } from './runtimes.ts'

/**
 * The operators' APIs main.node.ts mounts on the internal listener when OPERATOR_TOKEN is set,
 * each under its own base and behind the same token: where servers run (`runtimes.ts`, under
 * `/runtimes/v1`) and accounts, their servers and production's health (`ops.ts`, under
 * `/ops/v1`). The fleet's own operator API is mounted with the fleet, since only a deployment that
 * runs one has it. `api` is what the web's API is given beside the control plane, the same objects:
 * its realtime tickets and address give an operator's live watch of a console.
 */
export function operatorApis(
  app: ControlPlane,
  api: {
    health: PlatformHealth
    flySuspend: SuspendSwitch
    moderation: ModerationService
    tickets: Pick<RealtimeTickets, 'issueForOperator'>
    realtime: { fallbackUrl: string }
  },
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
      consoleWatch: new OperatorConsoleWatch({
        feed: app.feed,
        tickets: api.tickets,
        realtime: api.realtime,
      }),
      upkeep: app.servers.upkeep,
      token,
    }),
  )
  return apis
}
