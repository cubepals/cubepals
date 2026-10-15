// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Where the edge runs: the regions configured, and what flyctl does to put a machine in each. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { edgePlacement, edgeRegions } from './production-edge.ts'

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
