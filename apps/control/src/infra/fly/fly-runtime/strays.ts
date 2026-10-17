// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Machines in a server's app that nothing names: a server machine beside the one its handle
 * names, which a restore or a move that stopped partway made, and a helper whose work stopped
 * without destroying it. Found and destroyed, with the volumes they leave where Fly lets go of
 * them now; finding and deleting volumes is `volumes.ts`'s. When it is safe to ask is the caller's.
 */

import { HOUR_MS } from '@blockly/contracts/durations'
import type { FlyClient, FlySchemas } from '../client.ts'
import { META } from '../machine-config.ts'
import { HELPER_LIFETIME_MS } from './helper-machine.ts'
import { destroyMachine, serverMachines } from './machines.ts'
import { idOf, must } from './responses.ts'
import { deleteVolume, exportVolumes } from './volumes.ts'

type Machine = FlySchemas['Machine']

/** Past its lifetime, a helper Fly hasn't destroyed by itself is left over, with time for Fly to. */
const HELPER_SLACK_MS = HOUR_MS

/** The app's helper machines that aren't destroyed. */
async function helperMachines(fly: FlyClient, app: string): Promise<Machine[]> {
  const listed = await fly.GET('/v1/apps/{app_name}/machines', { params: { path: { app_name: app } } })
  if (listed.response.status === 404) return []
  return must(listed, 'listing machines').filter(
    (m) => m.config?.metadata?.[META.role] === 'helper' && m.state !== 'destroyed',
  )
}

/**
 * Every server machine in the app but `kept`, destroyed now that the handle naming it is saved,
 * and the volumes they mounted deleted but for `keptVolumes`. What Fly won't let go of now (a host
 * lost, a volume still bound) is logged and left for the leftover sweep.
 */
export async function clearOtherServers(
  fly: FlyClient,
  app: string,
  kept: string,
  keptVolumes: readonly (string | null)[],
): Promise<void> {
  const leftBehind = (id: string) => (error: unknown) =>
    console.warn(`fly: ${app} still holds ${id}; the leftover sweep tries again`, error)
  for (const machine of await serverMachines(fly, app)) {
    const machineId = idOf(machine, 'a machine')
    if (machineId === kept) continue
    const destroyed = await destroyMachine(fly, app, machineId).then(() => true, leftBehind(machineId))
    for (const mount of destroyed ? (machine.config?.mounts ?? []) : [])
      if (mount.volume !== undefined && !keptVolumes.includes(mount.volume))
        await deleteVolume(fly, app, mount.volume).catch(leftBehind(mount.volume))
  }
}

/**
 * Every helper in the app destroyed, then every export volume deleted: what an export that was
 * interrupted, or whose own delete Fly refused, left. For `release`, when nothing else runs there.
 */
export async function clearExports(fly: FlyClient, app: string): Promise<void> {
  for (const helper of await helperMachines(fly, app))
    await destroyMachine(fly, app, idOf(helper, 'a helper machine'))
  for (const volume of await exportVolumes(fly, app)) await deleteVolume(fly, app, idOf(volume, 'a volume'))
}

/**
 * Server machines no handle names, by id or by the volume they mount (Fly can replace a machine
 * under a new id on the same volume), and helpers past their lifetime, each asked once to go, with
 * no wait for Fly to finish: what it refuses stays for the next call. Asked only while nothing is
 * in flight for the server, since a restore makes its machine before a handle names it. Returns
 * the ids it destroyed.
 */
export async function destroyStrays(
  fly: FlyClient,
  app: string,
  named: { machines: readonly (string | null)[]; volumes: readonly (string | null)[] },
  now: number,
): Promise<string[]> {
  const servers = (await serverMachines(fly, app)).filter(
    (m) =>
      !named.machines.includes(m.id ?? null) &&
      !(m.config?.mounts ?? []).some((mount) => named.volumes.includes(mount.volume ?? null)),
  )
  const helpers = (await helperMachines(fly, app)).filter(
    (m) => Date.parse(m.created_at ?? '') + HELPER_LIFETIME_MS + HELPER_SLACK_MS < now,
  )
  const destroyed: string[] = []
  for (const machine of [...servers, ...helpers]) {
    if (machine.id === undefined) continue
    const answer = await fly.DELETE('/v1/apps/{app_name}/machines/{machine_id}', {
      params: { path: { app_name: app, machine_id: machine.id }, query: { force: true } },
    })
    if (answer.response.ok || answer.response.status === 404) destroyed.push(machine.id)
  }
  return destroyed
}
