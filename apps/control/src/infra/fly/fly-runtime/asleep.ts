// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which servers' machines are asleep with their memory on something other than what a start of
 * them would run now, so that a wake would boot rather than resume them, read from one listing of
 * the organization's machines, as `tags.ts` writes tags from one. That listing gives a machine's
 * metadata and not its mounts, which is all `sleptOn` reads: the same test a start makes.
 */
import type { RuntimeKey, RuntimeSpec } from '../../../app/ports/runtime.ts'
import type { FlyClient, FlySchemas } from '../client.ts'
import { isAsleep, META, sleptOn } from '../machine-config.ts'
import { must } from './responses.ts'

type Machine = FlySchemas['Machine']

/** The server whose machine this is, where a wake of it would boot rather than resume; null otherwise. */
function bootingOn(machine: Machine, deployment: string, asleep: ReadonlyMap<RuntimeKey, RuntimeSpec>) {
  const meta = machine.config?.metadata ?? {}
  if (meta[META.deployment] !== deployment || meta[META.role] !== 'minecraft') return null
  const key = meta[META.server] as RuntimeKey
  const spec = asleep.get(key)
  return spec !== undefined && isAsleep(machine) && !sleptOn(machine, spec) ? key : null
}

export async function wakesWouldBoot(
  fly: FlyClient,
  org: string,
  deployment: string,
  asleep: ReadonlyMap<RuntimeKey, RuntimeSpec>,
): Promise<Set<RuntimeKey>> {
  const boots = new Set<RuntimeKey>()
  if (asleep.size === 0) return boots
  let cursor: string | undefined
  do {
    const page = must(
      await fly.GET('/v1/orgs/{org_slug}/machines', {
        params: { path: { org_slug: org }, query: cursor ? { cursor } : {} },
      }),
      'listing machines',
    )
    for (const machine of (page.machines ?? []) as Machine[]) {
      const key = bootingOn(machine, deployment, asleep)
      if (key !== null) boots.add(key)
    }
    cursor = page.next_cursor || undefined
  } while (cursor)
  return boots
}
