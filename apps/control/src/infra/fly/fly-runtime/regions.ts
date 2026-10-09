/**
 * Regions on Fly: the Fly region a product region maps to, the map checked against Fly's live
 * regions at boot, and whether a region has room for a machine now. It makes nothing; machines
 * and volumes are made by the verbs in `fly-runtime.ts`.
 */

import { z } from 'zod'
import { type Placement, RuntimeFull, type RuntimeSpec } from '../../../app/ports/runtime.ts'
import type { FlyClient } from '../client.ts'
import { guestFor } from '../machine-config.ts'
import { must } from './responses.ts'

// The spec calls the list `regions`; the live API answers `Regions` (checked 2026-09-19). Either.
const Region = z.object({
  code: z.string(),
  deprecated: z.boolean().optional(),
  requires_paid_plan: z.boolean().optional(),
})
const RegionsBody = z.object({ Regions: z.array(Region).optional(), regions: z.array(Region).optional() })

// Placements are simulated, nothing is made. The spec's fields are lowercase; the live API
// answered `{"Regions":[{"Region":"fra","Count":1,"Concurrency":1}]}` (2026-09-19). Either.
const Placed = z.object({
  Region: z.string().optional(),
  region: z.string().optional(),
  Count: z.number().optional(),
  count: z.number().optional(),
})
const PlacementsBody = z.object({ Regions: z.array(Placed).optional(), regions: z.array(Placed).optional() })

/** The smallest server Blockly makes, for asking whether an org may place anything in a region. */
const SMALLEST = { memoryMb: 2048, sizeGb: 5 }

/** Every product region must name a live Fly region. Checked at boot, before anything is placed. */
export async function checkRegions(
  fly: FlyClient,
  org: string,
  regions: Readonly<Record<string, string>>,
): Promise<void> {
  const body = RegionsBody.parse(must(await fly.GET('/v1/platform/regions'), 'listing regions'))
  const live = new Map(
    (body.Regions ?? body.regions ?? []).filter((r) => !r.deprecated).map((r) => [r.code, r]),
  )
  const unknown = Object.entries(regions).filter(([, code]) => !live.has(code))
  if (unknown.length > 0)
    throw new Error(
      `These regions map to no live Fly region: ${unknown.map(([key, code]) => `${key} → ${code}`).join(', ')}. Fix FLY_REGION_MAP, or RUNTIME_REGION_MAP where Fly is the default runtime.`,
    )
  // A region only paid plans may use must take this organization's machines (§2).
  for (const [key, code] of Object.entries(regions))
    if (live.get(code)?.requires_paid_plan && !(await placeable(fly, org, code, SMALLEST)))
      throw new Error(
        `${key} → ${code} needs a paid Fly plan, and organization ${org} can't place machines there. Upgrade it, or map ${key} elsewhere.`,
      )
}

/**
 * Whether Fly would place one machine of this size, with its volume, in `code` now (§8:
 * capacity via `/v1/platform/placements`). A simulation: nothing is made.
 */
export async function placeable(
  fly: FlyClient,
  org: string,
  code: string,
  size: { memoryMb: number; sizeGb: number },
): Promise<boolean> {
  const body = PlacementsBody.parse(
    must(
      await fly.POST('/v1/platform/placements', {
        body: {
          org_slug: org,
          region: code,
          count: 1,
          compute: guestFor(size.memoryMb),
          volume_size_bytes: size.sizeGb * 2 ** 30,
        },
      }),
      'checking capacity',
    ),
  )
  return (body.Regions ?? body.regions ?? []).some(
    (p) => (p.Region ?? p.region) === code && (p.Count ?? p.count ?? 0) >= 1,
  )
}

export async function requireCapacity(
  fly: FlyClient,
  org: string,
  code: string,
  spec: RuntimeSpec,
): Promise<void> {
  const size = { memoryMb: spec.resources.memoryMb, sizeGb: spec.storage.sizeGb }
  if (!(await placeable(fly, org, code, size)))
    throw new RuntimeFull('fly', `nothing placeable for ${size.memoryMb} MB and ${size.sizeGb} GB in ${code}`)
}

export function flyRegion(regions: Readonly<Record<string, string>>, placement: Placement): string {
  const code = regions[placement.regionKey]
  if (!code) throw new Error(`The region ${placement.regionKey} has no Fly placement`)
  return code
}
