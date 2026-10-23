// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Where the edge runs: the regions configured, and what flyctl does to put a machine in each. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { MINUTE_MS } from '../packages/contracts/src/durations.ts'
import {
  type Clock,
  deployMachines,
  EDGE_ASK_EVERY_MS,
  EDGE_DRAIN_LIMIT_MS,
  EDGE_READY_LIMIT_MS,
  edgePlacement,
  edgeRegions,
  edgeSourceGaps,
  isReady,
  machinesIn,
  type RegionSteps,
  regionsToRoll,
  rollEdge,
  sumPlayers,
  waitForPlayers,
  whyNotReady,
} from './production-edge.ts'

const APP = 'bly-prod-edge'

describe('the regions the edge runs in', () => {
  test('fra alone when the environment lists none, as production runs today', () => {
    expect(edgeRegions(undefined)).toEqual(['fra'])
    expect(edgeRegions([])).toEqual(['fra'])
    const example = JSON.parse(
      readFileSync(
        join(import.meta.dir, '../infra/terraform/environments/production/config.auto.tfvars.example.json'),
        'utf8',
      ),
    ) as { edge_regions?: string[] }
    expect(edgeRegions(example.edge_regions)).toEqual(['fra'])
  })

  test('what is listed, in order', () => {
    expect(edgeRegions(['fra', 'iad'])).toEqual(['fra', 'iad'])
  })

  test('a name that is no Fly region, or one listed twice, stops the apply', () => {
    expect(() => edgeRegions(['fra', 'us'])).toThrow('us')
    expect(() => edgeRegions(['fra', 'IAD'])).toThrow('IAD')
    expect(() => edgeRegions(['iad', 'iad'])).toThrow('twice')
  })
})

describe('putting the edge where it is listed', () => {
  test('nothing to do when each region has its one machine', () => {
    expect(edgePlacement(APP, ['fra'], ['fra'])).toEqual([])
    expect(edgePlacement(APP, ['fra', 'iad'], ['iad', 'fra'])).toEqual([])
  })

  test('a region gained gets a machine, and the ones already there stay one each', () => {
    expect(edgePlacement(APP, ['fra', 'iad'], ['fra'])).toEqual([
      ['scale', 'count', '2', '--region', 'fra,iad', '--max-per-region', '1', '--app', APP, '--yes'],
    ])
  })

  test('a region dropped is let go only after the listed ones are in place', () => {
    expect(edgePlacement(APP, ['fra'], ['fra', 'iad'])).toEqual([
      ['scale', 'count', '0', '--region', 'iad', '--app', APP, '--yes'],
    ])
    expect(edgePlacement(APP, ['iad'], ['fra'])).toEqual([
      ['scale', 'count', '1', '--region', 'iad', '--max-per-region', '1', '--app', APP, '--yes'],
      ['scale', 'count', '0', '--region', 'fra', '--app', APP, '--yes'],
    ])
  })

  test('two machines in one listed region come back to one', () => {
    expect(edgePlacement(APP, ['fra', 'iad'], ['fra', 'fra', 'iad'])).toEqual([
      ['scale', 'count', '2', '--region', 'fra,iad', '--max-per-region', '1', '--app', APP, '--yes'],
    ])
  })
})

describe('fleet nodes on the internet letting every edge in', () => {
  const anycast = [
    { Address: '192.0.2.10', Type: 'v4', Region: 'global' },
    { Address: '2001:db8::10', Type: 'v6', Region: 'global' },
  ]
  const fra = [
    { Address: '198.51.100.1', Type: 'egress_v4', Region: 'fra' },
    { Address: '2001:db8:f::1', Type: 'egress_v6', Region: 'fra' },
  ]
  const iad = [
    { Address: '198.51.100.2', Type: 'egress_v4', Region: 'iad' },
    { Address: '2001:db8:1::1', Type: 'egress_v6', Region: 'iad' },
  ]

  test('nothing to do while no node takes the edge over the internet, as production runs today', () => {
    expect(edgeSourceGaps(APP, ['fra', 'iad'], anycast, [])).toEqual([])
  })

  test('every region’s egress addresses listed, as single-host ranges or bare', () => {
    const sources = ['198.51.100.1/32', '2001:db8:f::1/128', '198.51.100.2', '2001:db8:1::1/128']
    expect(edgeSourceGaps(APP, ['fra', 'iad'], [...anycast, ...fra, ...iad], sources)).toEqual([])
  })

  test('a region added to the edge after the list was made is named, address by address', () => {
    const sources = ['198.51.100.1/32', '2001:db8:f::1/128']
    expect(edgeSourceGaps(APP, ['fra', 'iad'], [...anycast, ...fra, ...iad], sources)).toEqual([
      '198.51.100.2, the edge’s egress address in iad, isn’t in fleet_hetzner.edge_sources',
      '2001:db8:1::1, the edge’s egress address in iad, isn’t in fleet_hetzner.edge_sources',
    ])
  })

  test('a region with no egress addresses says how to get them; the anycast ones never count', () => {
    expect(
      edgeSourceGaps(APP, ['fra', 'iad'], [...anycast, ...fra], ['198.51.100.1/32', '2001:db8:f::1/128']),
    ).toEqual([`The edge has no egress addresses in iad: fly ips allocate-egress --app ${APP} --region iad`])
  })
})

describe('the edge’s service', () => {
  test('caps its connections, so a second edge takes what one can’t', () => {
    const config = parse(readFileSync(join(import.meta.dir, '../infra/fly/edge.toml'), 'utf8')) as {
      services: {
        internal_port: number
        concurrency?: { type: string; soft_limit: number; hard_limit: number }
      }[]
    }
    const concurrency = config.services.find((s) => s.internal_port === 25565)?.concurrency
    expect(concurrency?.type).toBe('connections')
    expect(concurrency?.soft_limit).toBeLessThan(concurrency?.hard_limit ?? 0)
  })

  test('answers browsers on 80 and 443 in a service of their own, apart from Minecraft’s limits', () => {
    const config = parse(readFileSync(join(import.meta.dir, '../infra/fly/edge.toml'), 'utf8')) as {
      services: { internal_port: number; ports: { port: number; handlers?: string[] }[] }[]
    }
    const browsers = config.services.filter((s) => s.ports.some((p) => p.port === 80 || p.port === 443))
    expect(browsers.map((s) => s.internal_port)).toEqual([8080])
    expect(browsers[0]?.ports).toEqual([
      { port: 80, handlers: ['http'] },
      { port: 443, handlers: ['tls', 'http'] },
    ])
  })
})

/** A clock that only moves when slept on, and a log of what was done in what order. */
const world = () => {
  let now = 0
  const log: string[] = []
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  }
  return { clock, log, said: (line: string) => log.push(line), time: () => now }
}

const steps = (log: string[], over: Partial<RegionSteps> = {}): RegionSteps => ({
  cordon: async (r) => void log.push(`cordon ${r}`),
  othersReady: async () => true,
  uncordon: async (r) => void log.push(`uncordon ${r}`),
  players: async () => 0,
  deploy: async (r) => void log.push(`deploy ${r}`),
  ready: async (r) => {
    log.push(`ready ${r}`)
    return true
  },
  ...over,
})

/** A roll with cordoning on, as an operator turns it on; the default leaves a region in service. */
const roll = (
  regions: readonly string[],
  steps: RegionSteps,
  say: (line: string) => void,
  clock: Clock,
  options = { cordon: true },
) => rollEdge(regions, steps, say, clock, options)

describe('restarting the edge without cutting a player', () => {
  test('waits for the players to leave, and restarts as soon as they have', async () => {
    const w = world()
    const counts = [3, 2, 0]
    const wait = await waitForPlayers(async () => counts.shift() ?? 0, w.said, w.clock)
    expect(wait).toEqual({ left: 0, failed: 0, unsure: false })
    expect(w.time()).toBe(2 * EDGE_ASK_EVERY_MS)
    expect(w.log).toEqual(['waiting on 3 connected', 'waiting on 2 connected', 'no players connected'])
  })

  test('a query that fails is asked again, and a first silence is an edge that can’t count', async () => {
    const w = world()
    const reads: (number | null)[] = [3, null, 2, 0]
    const wait = await waitForPlayers(async () => reads.shift() ?? null, w.said, w.clock)
    expect(wait).toEqual({ left: 0, failed: 1, unsure: false })
    const first = world()
    const never = await waitForPlayers(async () => null, first.said, first.clock)
    expect(never).toEqual({ left: null, failed: 1, unsure: true })
    expect(first.time()).toBe(0)
  })

  test('once a count was read, only the limit ends the wait, on the last count', async () => {
    const w = world()
    let reads = 0
    const wait = await waitForPlayers(async () => (reads++ === 0 ? 3 : null), w.said, w.clock)
    expect(wait.left).toBe(3)
    expect(wait.unsure).toBe(true)
    expect(wait.failed).toBe(reads - 1)
    expect(w.time()).toBeGreaterThanOrEqual(EDGE_DRAIN_LIMIT_MS)
  })

  test('goes ahead at the limit, and says how many it cuts', async () => {
    const w = world()
    const wait = await waitForPlayers(async () => 4, w.said, w.clock)
    expect(wait.left).toBe(4)
    expect(w.time()).toBeGreaterThanOrEqual(EDGE_DRAIN_LIMIT_MS)
    expect(w.time()).toBeLessThan(EDGE_DRAIN_LIMIT_MS + EDGE_ASK_EVERY_MS)
    expect(w.log).toEqual(['waiting on 4 connected'])
  })

  test('the limit is ten minutes', () => {
    expect(EDGE_DRAIN_LIMIT_MS).toBe(10 * MINUTE_MS)
  })

  test('one region at a time: the next is not touched until the last is ready', async () => {
    const w = world()
    const { cut } = await roll(['fra', 'iad'], steps(w.log), () => {}, w.clock)
    expect(cut).toBe(0)
    expect(w.log).toEqual([
      ...['cordon fra', 'deploy fra', 'ready fra', 'uncordon fra'],
      ...['cordon iad', 'deploy iad', 'ready iad', 'uncordon iad'],
    ])
  })

  test('a region that is not up to date with the routes yet is waited on', async () => {
    const w = world()
    let asks = 0
    const { cut } = await roll(
      ['fra', 'iad'],
      steps(w.log, { ready: async (r) => (r === 'fra' && ++asks <= 3 ? 'routes are not current' : true) }),
      () => {},
      w.clock,
    )
    expect(cut).toBe(0)
    expect(asks).toBe(4)
    expect(w.log.indexOf('cordon iad')).toBeGreaterThan(w.log.indexOf('deploy fra'))
  })

  test('a region that never comes back ready stops the roll before the next', async () => {
    const w = world()
    await expect(
      roll(
        ['fra', 'iad'],
        steps(w.log, { ready: async () => 'its agent does not answer on the drain port' }),
        () => {},
        w.clock,
      ),
    ).rejects.toThrow(
      "The edge in fra wasn't ready 5 min after its deploy: its agent does not answer on the drain port",
    )
    expect(w.log).toEqual(['cordon fra', 'deploy fra', 'uncordon fra'])
    expect(w.time()).toBeGreaterThanOrEqual(EDGE_READY_LIMIT_MS)
  })

  test('counts the players cut across regions', async () => {
    const w = world()
    const said: string[] = []
    const { cut } = await roll(
      ['fra', 'iad'],
      steps(w.log, { players: async (r) => (r === 'fra' ? 2 : 0) }),
      (line) => said.push(line),
      w.clock,
    )
    expect(cut).toBe(2)
    expect(said).toContain('fra: restarting with 2 players still connected after 10 min; they are cut')
  })
})

describe('restarting the edge when a region can’t be cordoned or fails', () => {
  test('a single region is not cordoned, since no other takes its joins, but its players are waited on', async () => {
    const w = world()
    const counts = [2, 0]
    await roll(['fra'], steps(w.log, { players: async () => counts.shift() ?? 0 }), () => {}, w.clock)
    expect(w.log).toEqual(['deploy fra', 'ready fra'])
    expect(w.time()).toBe(EDGE_ASK_EVERY_MS)
  })

  test('a failure after the cordon, in the wait or the deploy, takes the region out of it again', async () => {
    const w = world()
    const broken = steps(w.log, {
      players: async () => {
        throw new Error('proxy failed')
      },
    })
    await expect(roll(['fra', 'iad'], broken, () => {}, w.clock)).rejects.toThrow('proxy failed')
    expect(w.log).toEqual(['cordon fra', 'uncordon fra'])
  })

  test('a region is not cordoned while no other region is ready to take its joins', async () => {
    const w = world()
    const said: string[] = []
    await roll(['fra', 'iad'], steps(w.log, { othersReady: async () => false }), (l) => said.push(l), w.clock)
    expect(w.log).not.toContain('cordon fra')
    expect(said).toContain('fra: deploying; it takes joins until it restarts, and none while it does')
  })

  test('a region where a machine can’t say is uncounted, however many the others read', async () => {
    const w = world()
    const result = await rollEdge(
      ['fra', 'iad'],
      steps(w.log, { players: async (r) => (r === 'fra' ? sumPlayers([0, null]) : 0) }),
      () => {},
      w.clock,
    )
    expect(result.uncounted).toEqual(['fra'])
  })

  test('a failed uncordon after a good restart says the region is still cordoned', async () => {
    const w = world()
    const stuck = steps(w.log, {
      uncordon: async () => {
        throw new Error('fly down')
      },
    })
    await expect(roll(['fra', 'iad'], stuck, () => {}, w.clock)).rejects.toThrow(
      'fra: is still cordoned and takes no joins: fly down',
    )
  })

  test('an edge that cannot count its players is reported as uncounted, not as none cut', async () => {
    const w = world()
    const said: string[] = []
    const result = await roll(
      ['fra', 'iad'],
      steps(w.log, { players: async (r) => (r === 'fra' ? null : 0) }),
      (line) => said.push(line),
      w.clock,
    )
    expect(result).toEqual({ cut: 0, uncounted: ['fra'] })
    expect(said).toContain("fra: it can't say how many players are connected, so none was waited for")
    expect(w.time()).toBe(0)
  })

  test('cordons nothing unless asked to', async () => {
    const w = world()
    await rollEdge(['fra', 'iad'], steps(w.log), () => {}, w.clock)
    expect(w.log).toEqual(['deploy fra', 'ready fra', 'deploy iad', 'ready iad'])
  })

  test('an uncordon that fails is tried again, and ends the roll if it never works', async () => {
    const w = world()
    let tries = 0
    const flaky = steps(w.log, {
      uncordon: async (r) => {
        if (++tries <= 2) throw new Error('fly hiccup')
        w.log.push(`uncordon ${r}`)
      },
    })
    await roll(['fra', 'iad'], flaky, () => {}, w.clock)
    expect(w.log.filter((l) => l.startsWith('uncordon'))).toEqual(['uncordon fra', 'uncordon iad'])

    const stuck = world()
    const never = steps(stuck.log, {
      uncordon: async () => {
        throw new Error('fly down')
      },
    })
    await expect(roll(['fra', 'iad'], never, () => {}, stuck.clock)).rejects.toThrow('fly down')
    expect(stuck.log).not.toContain('cordon iad')
  })

  test('says a region is still cordoned when its undo fails after another error', async () => {
    const w = world()
    const said: string[] = []
    const both = steps(w.log, {
      players: async () => {
        throw new Error('proxy failed')
      },
      uncordon: async () => {
        throw new Error('fly down')
      },
    })
    await expect(roll(['fra', 'iad'], both, (l) => said.push(l), w.clock)).rejects.toThrow('proxy failed')
    expect(said).toContain('fra: is still cordoned and takes no joins: fly down')
  })

  test('a cordon that fails partway is undone', async () => {
    const w = world()
    const half = steps(w.log, {
      cordon: async () => {
        throw new Error('cordoned one of two')
      },
    })
    await expect(roll(['fra', 'iad'], half, () => {}, w.clock)).rejects.toThrow('cordoned one of two')
    expect(w.log).toEqual(['uncordon fra'])
  })

  test('cordons when asked to, and a single region is waited on while it serves', async () => {
    const w = world()
    await roll(['fra', 'iad'], steps(w.log), () => {}, w.clock)
    expect(w.log[0]).toBe('cordon fra')
    const single = world()
    await rollEdge(['fra'], steps(single.log), () => {}, single.clock)
    expect(single.log).toEqual(['deploy fra', 'ready fra'])
  })
})

describe('every machine of the edge', () => {
  const machines = [
    { id: 'm1', region: 'fra' },
    { id: 'm2', region: 'fra' },
    { id: 'm3', region: 'iad' },
    { id: 'm4', region: 'ams' },
  ]

  test('a region’s machines are all named, and deployed by id so no other is touched', () => {
    expect(machinesIn(machines, 'fra')).toEqual(['m1', 'm2'])
    expect(deployMachines('bly-prod-edge', 'infra/fly/edge.toml', 'img:1', ['m1', 'm2'])).toEqual([
      ...['deploy', '--image', 'img:1', '--config', 'infra/fly/edge.toml', '--app', 'bly-prod-edge'],
      ...['--only-machines', 'm1,m2', '--update-only', '--yes', '--ha=false'],
    ])
  })

  test('a machine in a region left out of the list is rolled too, after the listed ones', () => {
    expect(regionsToRoll(machines, ['iad', 'fra'])).toEqual(['iad', 'fra', 'ams'])
    expect(regionsToRoll(machines, ['fra'])).toEqual(['fra', 'ams', 'iad'])
    expect(regionsToRoll(machines, ['sjc'])).toEqual(['ams', 'fra', 'iad'])
  })

  test('players add up across a region’s machines; none is counted where none can say', () => {
    expect(sumPlayers([2, 3])).toBe(5)
    expect(sumPlayers([2, null])).toBeNull()
    expect(sumPlayers([0, null])).toBeNull()
    expect(sumPlayers([null, null])).toBeNull()
  })

  test('an agent that says nothing is ready only for an image from before the drain port', () => {
    expect(isReady(null, false)).toBe(true)
    expect(isReady(null)).toBe(false)
    expect(isReady({ players: 0, routesCurrent: false, bedrock: 'none' })).toBe(false)
    expect(isReady({ players: 0, routesCurrent: true, bedrock: 'none' })).toBe(true)
    expect(isReady({ players: 0, routesCurrent: true, bedrock: 'bound' })).toBe(true)
  })

  test('a machine whose Geyser is not bound yet is not ready, so the next region waits', () => {
    expect(isReady({ players: 0, routesCurrent: true, bedrock: 'unbound' })).toBe(false)
    expect(whyNotReady({ players: 0, routesCurrent: true, bedrock: 'unbound' })).toBe(
      'Geyser has not bound its port yet',
    )
    expect(whyNotReady({ players: 0, routesCurrent: false, bedrock: 'none' })).toBe(
      'it does not hold the newest routes yet',
    )
    expect(whyNotReady(null)).toBe('its agent does not answer on the drain port')
  })
})
