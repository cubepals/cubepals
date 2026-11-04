// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `tick query` read from a server's console. Every answer here is what a vanilla 1.21.11 server
 * sent back over RCON to the control plane's own client (`infra/mc-protocol/rcon.ts`), word for
 * word: keeping up, behind, frozen, sprinting, and an older server's refusal.
 */
import { describe, expect, test } from 'bun:test'
import { parseTickQuery } from './console.ts'

const RUNNING =
  'The game is running normallyTarget tick rate: 20.0 per second.\nAverage time per tick: 0.2ms (Target: 50.0ms)Percentiles: P50: 0.2ms P95: 0.3ms P99: 1.6ms. Sample: 100'
const LAGGING =
  "The game is running, but can't keep up with the target tick rateTarget tick rate: 10000.0 per second.\nAverage time per tick: 0.2ms (Target: 0.1ms)Percentiles: P50: 0.2ms P95: 0.3ms P99: 1.1ms. Sample: 100"
const FROZEN =
  'The game is frozenTarget tick rate: 20.0 per second.\nAverage time per tick: 0.2ms (Target: 50.0ms)Percentiles: P50: 0.2ms P95: 0.3ms P99: 1.6ms. Sample: 100'
const SPRINTING =
  'The game is sprintingTarget tick rate: 20.0 per second (ignored, reference only).\nAverage time per tick: 0.2msPercentiles: P50: 0.2ms P95: 0.3ms P99: 1.6ms. Sample: 100'
const UNKNOWN = 'Unknown or incomplete command. See below for errortock query<--[HERE]'

describe('tick query, as a server’s console answers it', () => {
  test('a server keeping up: its rate, its average and its percentiles', () => {
    expect(parseTickQuery(RUNNING)).toEqual({
      state: 'running',
      targetTps: 20,
      msptMean: 0.2,
      msptP50: 0.2,
      msptP95: 0.3,
      msptP99: 1.6,
    })
  })

  test('a server behind its rate says so', () => {
    expect(parseTickQuery(LAGGING)).toMatchObject({ state: 'lagging', targetTps: 10_000, msptP99: 1.1 })
  })

  test('a frozen or sprinting server is read as such', () => {
    expect(parseTickQuery(FROZEN)?.state).toBe('frozen')
    expect(parseTickQuery(SPRINTING)).toMatchObject({ state: 'sprinting', targetTps: 20, msptMean: 0.2 })
  })

  test('anything else is no reading', () => {
    expect(parseTickQuery(UNKNOWN)).toBeNull()
    expect(parseTickQuery('')).toBeNull()
    expect(parseTickQuery('There are 0 of a max of 20 players online: ')).toBeNull()
  })
})
