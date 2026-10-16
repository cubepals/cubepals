// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Where the edge runs: the regions configured, and what flyctl does to put a machine in each. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { edgePlacement, edgeRegions, edgeSourceGaps } from './production-edge.ts'

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
})
