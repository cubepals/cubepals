// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the edge runs: one machine in each region `edge_regions` lists (config.auto.tfvars.json),
 * fra alone when it lists none. The edge's addresses are anycast, so Fly's proxy hands a player to
 * the nearest of them, and that machine dials the server's Flycast address from there: a North
 * American player on a server in iad stays in North America with an edge in iad, rather than
 * crossing to fra and back. Every edge pulls the same routes, and the control plane waits on each
 * of them before a server reads as running (apps/control/src/app/edge/routed.ts).
 *
 * Terraform counts the machines against the org's limit (`edge_regions` in the stack); this file
 * only says what flyctl does after a deploy, and whether fleet nodes on the internet let every edge
 * in. The commands are production.ts's to run.
 */

/** Where the edge runs when the environment doesn't say: infra/fly/edge.toml's primary region. */
const DEFAULT_EDGE_REGIONS = ['fra'] as const

/** The regions the edge runs in, checked: Fly region codes, each once, at least one. */
export function edgeRegions(listed: readonly string[] | undefined): string[] {
  const regions = listed === undefined || listed.length === 0 ? [...DEFAULT_EDGE_REGIONS] : [...listed]
  const bad = regions.filter((region) => !/^[a-z]{3}$/.test(region))
  if (bad.length > 0) throw new Error(`edge_regions holds ${bad.join(', ')}, which aren't Fly region codes`)
  if (new Set(regions).size !== regions.length) throw new Error('edge_regions lists a region twice')
  return regions
}

/**
 * The flyctl calls that leave `app` with one machine in each of `regions`, given the regions its
 * machines are in now: the missing ones made first, so an edge always answers, then any in a
 * region no longer listed let go.
 */
export function edgePlacement(
  app: string,
  regions: readonly string[],
  present: readonly string[],
): string[][] {
  const calls: string[][] = []
  const counts = new Map<string, number>()
  for (const region of present) counts.set(region, (counts.get(region) ?? 0) + 1)
  if (regions.some((region) => counts.get(region) !== 1))
    calls.push([
      ...['scale', 'count', String(regions.length), '--region', regions.join(',')],
      ...['--max-per-region', '1', '--app', app, '--yes'],
    ])
  for (const region of counts.keys())
    if (!regions.includes(region))
      calls.push(['scale', 'count', '0', '--region', region, '--app', app, '--yes'])
  return calls
}

/** One of the edge app's addresses, as `fly ips list --json` lists it. */
export interface FlyAddress {
  Address: string
  Type: string
  Region: string
}

/**
 * What keeps fleet nodes on the internet from hearing every edge, as lines to act on; none when it
 * is all there. A node's firewall lets the game ports in only from `fleet_hetzner.edge_sources`
 * (modules/fleet-node), and an edge machine reaches a node from its own region's egress addresses,
 * which Fly gives an app region by region. Without them, a machine dials out from its host's
 * address, which changes when the machine moves. An empty list means no node takes the edge over
 * the internet, so nothing is needed.
 */
export function edgeSourceGaps(
  app: string,
  regions: readonly string[],
  addresses: readonly FlyAddress[],
  sources: readonly string[],
): string[] {
  if (sources.length === 0) return []
  const listed = new Set(sources.map((source) => source.replace(/\/(32|128)$/, '')))
  const gaps: string[] = []
  for (const region of regions) {
    const egress = addresses.filter((a) => a.Type.includes('egress') && a.Region === region)
    if (egress.length === 0) {
      gaps.push(
        `The edge has no egress addresses in ${region}: fly ips allocate-egress --app ${app} --region ${region}`,
      )
      continue
    }
    for (const { Address } of egress)
      if (!listed.has(Address))
        gaps.push(`${Address}, the edge’s egress address in ${region}, isn’t in fleet_hetzner.edge_sources`)
  }
  return gaps
}
