// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A recording run started again in place: asked once, then done only once the cache's state stops
 * saying it records and the game answers again, or given up on in time. The machine is a script of
 * answers and the clock moves only when the start again waits.
 */
import { describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { RECORDS, START_AGAIN } from '../../../minecraft/start-cache.ts'
import { startedAgain } from './started-again.ts'

/** A machine whose cache says each of `states` in turn, then the last for ever, and a game that answers from `upAt`. */
function machine(states: string[], options: { asks?: number; upAt?: number } = {}) {
  let clock = 0
  let read = 0
  const asked: string[][] = []
  return {
    asked,
    clock: () => clock,
    deps: {
      exec: async (command: readonly string[]) => {
        asked.push([...command])
        if (command === START_AGAIN) return { exitCode: options.asks ?? 0, stdout: '' }
        const state = states[Math.min(read++, states.length - 1)] ?? RECORDS
        return { exitCode: 0, stdout: `${state}\n` }
      },
      answers: async () => clock >= (options.upAt ?? 0),
      wait: async (ms: number) => {
        clock += ms
      },
      now: () => clock,
    },
  }
}

describe('a recording run started again in place', () => {
  test('asks once, then is done when its cache is made and the game answers', async () => {
    const box = machine([RECORDS, RECORDS, 'made'])
    expect(await startedAgain(box.deps)).toBe(true)
    expect(box.asked[0]).toEqual([...START_AGAIN])
    expect(box.asked.filter((command) => command[0] === 'sh')).toHaveLength(1)
  })

  test('isn’t done while the game doesn’t answer yet, cache made or not', async () => {
    const box = machine(['made'], { upAt: 30_000 })
    expect(await startedAgain(box.deps)).toBe(true)
    expect(box.clock()).toBeGreaterThanOrEqual(30_000)
  })

  test('a cache that failed to make still starts the server: done when it answers', async () => {
    expect(await startedAgain(machine([RECORDS, 'failed']).deps)).toBe(true)
  })

  test('a machine where nothing records is asked nothing more: the sleep stops as it used to', async () => {
    const box = machine([RECORDS], { asks: 1 })
    expect(await startedAgain(box.deps)).toBe(false)
    expect(box.asked).toHaveLength(1)
    expect(box.clock()).toBe(0)
  })

  test('one still recording when its time is up is given up on', async () => {
    const box = machine([RECORDS])
    expect(await startedAgain(box.deps, 2 * MINUTE_MS)).toBe(false)
    expect(box.clock()).toBeGreaterThanOrEqual(2 * MINUTE_MS)
  })
})
