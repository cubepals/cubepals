// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finds this deployment's servers among the organization's apps and machines on Fly: every one
 * there is, and the machines that changed since a moment. It reads only; what a machine's state
 * means is `observation.ts`, and the server a key names is the app `apps.ts` names.
 */

import type { RuntimeKey } from '../../../app/ports/runtime.ts'
import type { FlyClient } from '../client.ts'
import { encodeHandle } from '../handle.ts'
import { META, parsePorts } from '../machine-config.ts'
import { appPrefix, keyFromApp } from './apps.ts'
import { minecraftMachine } from './machines.ts'
import { stateOf } from './observation.ts'
import { must } from './responses.ts'
import { dataVolume } from './volumes.ts'

export async function* inventory(fly: FlyClient, org: string, deployment: string) {
  const apps = must(await fly.GET('/v1/apps', { params: { query: { org_slug: org } } }), 'listing apps')
  for (const app of apps.apps ?? []) {
    const name = app.name ?? ''
    const key = keyFromApp(name, appPrefix(deployment))
    if (key === null) continue
    const machine = await minecraftMachine(fly, name)
    const volume = machine ? null : await dataVolume(fly, name)
    yield {
      key,
      handle: encodeHandle({
        deployment: deployment,
        serverId: key,
        app: name,
        region: machine?.region ?? volume?.region ?? '',
        volumeId: machine?.config?.metadata?.[META.volume] ?? volume?.id ?? null,
        machineId: machine?.id ?? null,
        ports: parsePorts(machine?.config?.metadata?.[META.ports]),
      }),
    }
  }
}

export async function* changedSince(fly: FlyClient, org: string, deployment: string, since: Date) {
  // A minute of overlap: the list is a point in time, and a change can reach it late.
  const updatedAfter = new Date(since.getTime() - 60_000).toISOString()
  const unread = new Set<string>()
  let cursor: string | undefined
  do {
    const page = must(
      await fly.GET('/v1/orgs/{org_slug}/machines', {
        params: {
          path: { org_slug: org },
          // Destroyed machines too, so compute that went away is seen going.
          query: { updated_after: updatedAfter, include_deleted: true, ...(cursor ? { cursor } : {}) },
        },
      }),
      'listing changed machines',
    )
    for (const region of page.error_regions ?? []) unread.add(region)
    for (const machine of page.machines ?? []) {
      const meta = machine.config?.metadata ?? {}
      if (meta[META.deployment] !== deployment || meta[META.role] !== 'minecraft') continue
      if (!machine.app_name || !machine.id || !meta[META.server]) continue
      const key = meta[META.server] as RuntimeKey
      yield {
        key,
        handle: encodeHandle({
          deployment: deployment,
          serverId: key,
          app: machine.app_name,
          region: machine.region ?? '',
          volumeId: meta[META.volume] ?? null,
          machineId: machine.id,
          ports: parsePorts(meta[META.ports]),
        }),
        observation: { state: stateOf(machine.state), at: new Date(machine.updated_at ?? Date.now()) },
      }
    }
    cursor = page.next_cursor || undefined
  } while (cursor)
  if (unread.size > 0) throw new Error(`Fly couldn't list the machines in ${[...unread].join(', ')}`)
}
