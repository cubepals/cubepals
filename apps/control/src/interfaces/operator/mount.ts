import { Hono } from 'hono'
import type { ControlPlane } from '../../app/control-plane.ts'
import { createOpsApi } from './ops.ts'
import { createRuntimesApi } from './runtimes.ts'

/**
 * The operators' APIs main.node.ts mounts on the internal listener when OPERATOR_TOKEN is set,
 * each under its own base and behind the same token: where servers run (`runtimes.ts`, under
 * `/runtimes/v1`) and accounts and their servers (`ops.ts`, under `/ops/v1`). The fleet's own
 * operator API is mounted with the fleet, since only a deployment that runs one has it.
 */
export function operatorApis(app: ControlPlane, token: string): Hono {
  const apis = new Hono()
  apis.route('/', createRuntimesApi({ placement: app.placement, economics: app.economics, token }))
  apis.route('/', createOpsApi({ ...app, upkeep: app.servers.upkeep, token }))
  return apis
}
