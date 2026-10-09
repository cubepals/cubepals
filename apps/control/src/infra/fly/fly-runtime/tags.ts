/**
 * Writes servers' tags onto their Fly machines' metadata, through the metadata endpoint, which
 * neither restarts a machine nor needs its lease. Which tags a server has is the caller's; how a
 * tag is spelled as metadata is `machine-config.ts`.
 */

import type { RuntimeKey, RuntimeTags } from '../../../app/ports/runtime.ts'
import type { FlyClient } from '../client.ts'
import { heldTags, META, tagMetadata } from '../machine-config.ts'
import { must } from './responses.ts'

/**
 * Machine metadata, which `fly machine status` and the Machines API show, and the API filters
 * by (`?metadata.blockly_owner=…`). Written through the metadata endpoint, which leaves the
 * machine as it is, from one listing of the organization's machines; a tag no longer asked for
 * is removed. One machine that can't be written never holds up the rest.
 */
export async function tagMachines(
  fly: FlyClient,
  org: string,
  deployment: string,
  servers: ReadonlyMap<RuntimeKey, RuntimeTags>,
): Promise<number> {
  let written = 0
  const failed: string[] = []
  let cursor: string | undefined
  do {
    const page = must(
      await fly.GET('/v1/orgs/{org_slug}/machines', {
        params: { path: { org_slug: org }, query: cursor ? { cursor } : {} },
      }),
      'listing machines',
    )
    for (const machine of page.machines ?? []) {
      const meta = machine.config?.metadata ?? {}
      if (meta[META.deployment] !== deployment || meta[META.role] !== 'minecraft') continue
      const tags = servers.get(meta[META.server] as RuntimeKey)
      if (tags === undefined || !machine.app_name || !machine.id) continue
      const wanted = tagMetadata(tags)
      const held = heldTags(meta)
      // An empty value removes a key.
      const change = {
        ...Object.fromEntries(Object.keys(held).map((key) => [key, ''])),
        ...wanted,
      }
      if (Object.entries(change).every(([key, value]) => (held[key] ?? '') === value)) continue
      const result = await fly.PATCH('/v1/apps/{app_name}/machines/{machine_id}/metadata', {
        params: { path: { app_name: machine.app_name, machine_id: machine.id } },
        body: { metadata: change },
      })
      if (result.response.ok) written++
      else failed.push(`${machine.app_name} (${result.response.status})`)
    }
    cursor = page.next_cursor || undefined
  } while (cursor)
  if (failed.length > 0) throw new Error(`Fly couldn't tag ${failed.join(', ')}`)
  return written
}
