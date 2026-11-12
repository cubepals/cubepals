// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the edge runs: one machine in each region `edge_regions` lists (config.auto.tfvars.json),
 * fra alone when it lists none. The play names point at the edge's anycast addresses unless the
 * environment's `PLAY_IPV4` names another IPv4, such as one Fly announces from a single region
 * (infra/terraform/stack). On the anycast ones Fly's proxy hands a player to the nearest machine,
 * and that machine dials the server's Flycast address from there: a North American player on a
 * server in iad stays in North America with an edge in iad, rather than crossing to fra and back.
 * On a single region's address every IPv4 join enters Fly in that region, unless the server is in
 * a region `PLAY_IPV4_BY_REGION` gives an address of its own, announced from an edge region: the
 * control plane keeps an A record at that address for each of the server's names
 * (apps/control/src/app/edge/play-records.ts), and its joins enter Fly there.
 * Every edge pulls the same routes, and the control plane waits on each of them before a server
 * reads as running (apps/control/src/app/edge/routed.ts).
 *
 * A deploy restarts the edge one region at a time, every machine it has: each region's players
 * are waited on (up to `EDGE_DRAIN_LIMIT_MS`), its machines are deployed, and the next region waits
 * until they are well, hold the newest routes and, where Bedrock is taken, have Geyser bound. A
 * region whose players are still connected at the limit is left on the release it runs, for the
 * next deploy to take: a restart ends every session through it, and a player can't be handed to
 * another machine. Only a deploy told to (`cut`: a rollback, or `EDGE_CUT=1`) restarts it anyway,
 * and counts the players it cut. While a region restarts, Fly's proxy sends its joins to the
 * others; a few are lost as its machine stops (23 of 336 from one probe on staging).
 * The flyctl calls are production-edge-deploy.ts's; this file decides.
 *
 * Terraform counts the machines against the org's limit (`edge_regions` in the stack); this file
 * only says what flyctl does after a deploy, and whether fleet nodes on the internet let every edge
 * in. The commands are production.ts's to run.
 */

import { MINUTE_MS, SECOND_MS } from '../packages/contracts/src/durations.ts'

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

/** The longest a restart waits for an edge's players to leave; past it, the region is left, or its players cut where the deploy says so. */
export const EDGE_DRAIN_LIMIT_MS = 10 * MINUTE_MS

/** The longest a restarted edge has to be well and hold the newest routes before the roll stops. */
export const EDGE_READY_LIMIT_MS = 5 * MINUTE_MS

/** How often an edge is asked how many players it carries, and whether it is ready. */
export const EDGE_ASK_EVERY_MS = 5 * SECOND_MS

/** How a wait for players ended. */
export interface Wait {
  /** Players still connected at the last count read; null where the edge never counted. */
  left: number | null
  /** Queries for the count that failed along the way. */
  failed: number
  /** Whether the last query failed, so `left` may be out of date or absent. */
  unsure: boolean
}

/**
 * Waits until `players()` reads zero, for at most `limitMs`. A query that fails is asked again at
 * the next turn: once an edge has counted, only the limit ends the wait, with the last count it
 * gave. An edge whose first query fails can't count at all (one from before the drain port), and
 * nothing is waited for. `say` gets a line when the count changes.
 */
export async function waitForPlayers(
  players: () => Promise<number | null>,
  say: (line: string) => void,
  clock: Clock,
  limitMs = EDGE_DRAIN_LIMIT_MS,
): Promise<Wait> {
  const until = clock.now() + limitMs
  let last: number | null = null
  let failed = 0
  for (;;) {
    const count = await players()
    if (count !== null && count !== last)
      say(count === 0 ? 'no players connected' : `waiting on ${count} connected`)
    if (count === null) failed++
    last = count ?? last
    const over = count === 0 || (count === null && last === null) || clock.now() >= until
    if (over) return { left: last, failed, unsure: count === null }
    await clock.sleep(EDGE_ASK_EVERY_MS)
  }
}

/**
 * Waits until `check()` answers true, for at most `limitMs`; true, or the reason it gave last.
 * A check that throws counts as not ready, with the error as its reason.
 */
export async function waitUntil(
  check: () => Promise<true | string>,
  clock: Clock,
  limitMs: number,
): Promise<true | string> {
  const until = clock.now() + limitMs
  for (;;) {
    const answer = await check().catch(
      (error) => `the check failed: ${error instanceof Error ? error.message : error}`,
    )
    if (answer === true || clock.now() >= until) return answer
    await clock.sleep(EDGE_ASK_EVERY_MS)
  }
}

/** What restarting one region's machine takes, in the order it is done. */
export interface RegionSteps {
  /** Takes no new connections; the players in stay. */
  cordon: (region: string) => Promise<void>
  /** Whether a machine in another region is well and holds the newest routes, to take its joins. */
  othersReady: (region: string) => Promise<boolean>
  /** Takes connections again; harmless where it already does. */
  uncordon: (region: string) => Promise<void>
  /** How many players are connected through the region's machine; null when it can't say. */
  players: (region: string) => Promise<number | null>
  /** Puts the new release on the region's machine and waits until it passes Fly's checks. */
  deploy: (region: string) => Promise<void>
  /** True once the region's machines answer and hold the control plane's newest routes; else why not. */
  ready: (region: string) => Promise<true | string>
}

/**
 * Restarts the edge one region at a time: its players are waited on, then it is deployed and
 * waited on until ready, and only then the next. With `options.cordon` a region is first cordoned
 * while another is ready to take its joins, so no new join arrives while its players finish; that
 * is off by default, since on staging a cordoned region made the other region's probe fail nearly
 * every join. Without it a region serves while it is waited on. A region that doesn't come back
 * ready, or fails anywhere on the way, takes connections again and stops the roll with the others
 * as they were. A region whose players are still connected when the wait ends is left as it is,
 * and the roll goes on to the next, unless `options.cut` says a restart can't wait for them.
 * Returns how many players were counted and cut, the regions that couldn't count theirs, and the
 * regions left on the release they ran.
 */
export async function rollEdge(
  regions: readonly string[],
  steps: RegionSteps,
  say: (line: string) => void,
  clock: Clock,
  options: { cordon: boolean; cut?: boolean } = { cordon: false },
): Promise<Rolled> {
  let cut = 0
  const uncounted: string[] = []
  const left: string[] = []
  for (const region of regions) {
    const cordoned = options.cordon && regions.length > 1 && (await steps.othersReady(region))
    say(`${region}: ${cordoned ? 'taking no new joins, ' : ''}waiting for its players to leave`)
    // Whether the region's turn ended without an error: restarted, or left with its players on.
    let done = false
    try {
      if (cordoned) await steps.cordon(region)
      const said = (line: string) => say(`${region}: ${line}`)
      const wait = await restartRegion(region, cordoned, steps, said, clock, options.cut === true)
      done = true
      cut += tally(region, wait, uncounted, left)
    } finally {
      // Taking joins again is never skipped. Its failure ends the roll, after a region that was
      // left as much as after one restarted: the next region must not be cordoned while this one
      // takes no joins. Where another error already ends it, that one is thrown and this one is
      // said, since the region stays cordoned.
      if (cordoned)
        await uncordonAgain(region, steps, clock).catch((error) => {
          const stuck = `${region}: is still cordoned and takes no joins: ${error instanceof Error ? error.message : error}`
          if (done) throw new Error(stuck)
          say(stuck)
        })
    }
  }
  return { cut, uncounted, left }
}

/** Notes how one region's turn ended in the roll's lists; the players it cut. */
function tally(
  region: string,
  wait: Wait & { restarted: boolean },
  uncounted: string[],
  left: string[],
): number {
  if (!wait.restarted) {
    left.push(region)
    return 0
  }
  if (wait.unsure) uncounted.push(region)
  return wait.left ?? 0
}

/** How a roll went: the players counted and cut, the regions that couldn't count theirs, and those left as they were. */
export interface Rolled {
  cut: number
  uncounted: string[]
  left: string[]
}

/** What a roll's end says of the players it met, as lines. */
export function rolledLines({ cut, uncounted, left }: Rolled): string[] {
  const lines: string[] = []
  if (left.length > 0)
    lines.push(
      `edge: ${left.join(', ')} still had players connected and ${left.length === 1 ? 'was' : 'were'} left on the release ${left.length === 1 ? 'it runs' : 'they run'}; the next deploy takes ${left.length === 1 ? 'it' : 'them'}.`,
    )
  if (uncounted.length > 0)
    lines.push(
      `edge: ${uncounted.join(', ')} couldn’t say how many players were connected, so the players cut there are unknown.`,
    )
  if (cut > 0) lines.push(`edge: restarted with ${cut} counted players still connected; they were cut.`)
  else if (uncounted.length === 0) lines.push('edge: no player was cut.')
  return lines
}

/** Takes the region's connections again, tried a few times before giving up. */
async function uncordonAgain(region: string, steps: RegionSteps, clock: Clock): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await steps.uncordon(region)
    } catch (error) {
      if (attempt >= 3) throw error
      await clock.sleep(EDGE_ASK_EVERY_MS)
    }
  }
}

/**
 * One region's players waited on, the machine deployed and waited on; how the wait ended, and
 * whether it restarted. With players still connected at the limit it restarts only where `cut`.
 */
async function restartRegion(
  region: string,
  cordoned: boolean,
  steps: RegionSteps,
  say: (line: string) => void,
  clock: Clock,
  cut: boolean,
): Promise<Wait & { restarted: boolean }> {
  const wait = await waitForPlayers(() => steps.players(region), say, clock)
  const after = `after ${EDGE_DRAIN_LIMIT_MS / MINUTE_MS} min`
  if (wait.left === null) say("it can't say how many players are connected, so none was waited for")
  else if (wait.left > 0 && cut)
    say(`restarting with ${wait.left} players still connected ${after}; they are cut`)
  if (wait.failed > 0)
    say(`${wait.failed} queries for the count failed${wait.unsure ? ', the last one too' : ''}`)
  if (wait.left !== null && wait.left > 0 && !cut) {
    say(`${wait.left} players still connected ${after}; left on its release, for the next deploy`)
    return { ...wait, restarted: false }
  }
  say(cordoned ? 'deploying' : 'deploying; it takes joins until it restarts, and none while it does')
  await steps.deploy(region)
  const ready = await waitUntil(() => steps.ready(region), clock, EDGE_READY_LIMIT_MS)
  if (ready !== true)
    throw new Error(
      `The edge in ${region} wasn't ready ${EDGE_READY_LIMIT_MS / MINUTE_MS} min after its deploy: ${ready}. The other regions are as they were.`,
    )
  say('well and up to date with the routes')
  return { ...wait, restarted: true }
}

/** A Fly machine, as `fly machines list --json` lists it. */
export interface Machine {
  id: string
  region: string
  config?: { image?: string }
}

/** The ids of the app's machines in `region`: an edge may run more than one there. */
export const machinesIn = (machines: readonly Machine[], region: string): string[] =>
  machines.filter((m) => m.region === region).map((m) => m.id)

/**
 * The regions to roll: every one the app has a machine in, the configured ones first in their
 * order, then the rest by name, so a machine left in a region since removed from the list is
 * updated too.
 */
export function regionsToRoll(machines: readonly Machine[], configured: readonly string[]): string[] {
  const present = new Set(machines.map((m) => m.region))
  const rest = [...present].filter((r) => !configured.includes(r)).sort()
  return [...configured.filter((r) => present.has(r)), ...rest]
}

/** The flyctl call that puts `image` on exactly these machines and restarts nothing else. */
export const deployMachines = (
  app: string,
  config: string,
  image: string,
  ids: readonly string[],
): string[] => [
  ...['deploy', '--image', image, '--config', config, '--app', app],
  ...['--only-machines', ids.join(','), '--update-only', '--yes', '--ha=false'],
]

/** The players across a region's machines; null when any of them could not say. */
export function sumPlayers(counts: readonly (number | null)[]): number | null {
  const known = counts.filter((c): c is number => c !== null)
  return known.length < counts.length ? null : known.reduce((a, b) => a + b, 0)
}

/** What an edge's agent says to a deploy (apps/edge/drain.ts). */
export interface DrainState {
  players: number
  routesCurrent: boolean
  bedrock: 'none' | 'bound' | 'unbound'
}

/**
 * Why a restarted machine is not ready by what its agent says, or null when it is: it holds the newest routes, and
 * Geyser has bound its port where Bedrock players are taken, since Fly delivers their UDP to a
 * machine from boot. An agent that says nothing is not ready, unless the image predates the drain
 * port (`drains` false, as in a rollback to one): then Fly's own checks, which the deploy has
 * already waited for, are all there is.
 */
export function whyNotReady(state: DrainState | null, drains = true): string | null {
  if (state === null) return drains ? 'its agent does not answer on the drain port' : null
  if (!state.routesCurrent) return 'it does not hold the newest routes yet'
  return state.bedrock === 'unbound' ? 'Geyser has not bound its port yet' : null
}

/** Whether a restarted machine is ready (`whyNotReady`). */
export const isReady = (state: DrainState | null, drains = true): boolean =>
  whyNotReady(state, drains) === null
