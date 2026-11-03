// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The countdown players read before a restart: to whoever is on, and to nobody otherwise, and never
 * later than it says, however the console answers.
 */
import { describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { announce, LIST_UUIDS } from '../../../minecraft/console.ts'
import type { ConsoleTarget } from '../../ports/minecraft.ts'
import { RESTARTING, RESTARTING_FOR_A_CHANGE } from './restart-notice.ts'
import { COUNTDOWN, restartLine, warnBeforeRestart } from './restart-warning.ts'

const target: ConsoleTarget = { endpoint: { host: 'game.test', port: 25575 }, passwords: ['secret'] }

/** A console that never answers, as one held up behind another session's lock. */
const HANGS = Symbol('hangs')

type Answer = string | Error | typeof HANGS

/**
 * A game console that answers `list uuids` as `listing` and each line as `announcing`, and records
 * every command and pause.
 */
const game = (listing: Answer, announcing: Answer = '') => {
  const heard: string[] = []
  const paused: number[] = []
  const console = {
    run: async (to: ConsoleTarget, command: string): Promise<string> => {
      expect(to).toBe(target)
      heard.push(command)
      const answer = command === LIST_UUIDS ? listing : announcing
      if (answer === HANGS) return new Promise(() => undefined)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  const pause = async (ms: number) => {
    paused.push(ms)
  }
  return { console, pause, heard, paused }
}

const two =
  'There are 2 of a max of 10 players online: Alex (8667ba71-b85a-4004-af54-457a9734eed7), Sam (0f3c1d2e-1111-4222-8333-444455556666)'

describe('the countdown before a restart', () => {
  test('counts down to whoever is on: ten seconds, then three, then the restart', async () => {
    const g = game(two)
    expect(await warnBeforeRestart(g.console, target, RESTARTING_FOR_A_CHANGE, g.pause)).toBe(2)
    expect(g.heard).toEqual([
      LIST_UUIDS,
      announce(restartLine(10, RESTARTING_FOR_A_CHANGE)),
      announce(restartLine(3, RESTARTING_FOR_A_CHANGE)),
    ])
    expect(g.paused).toEqual([7000, 3000])
  })

  test('a change says why, and when they can come back', () => {
    expect(COUNTDOWN).toEqual([10, 3])
    expect(restartLine(10, RESTARTING_FOR_A_CHANGE)).toBe(
      'The server restarts in 10 seconds for a change its owner made. You can join again in about a minute.',
    )
    expect(restartLine(3, RESTARTING_FOR_A_CHANGE)).toBe('Restarting in 3 seconds. See you in a minute.')
  })

  test('a plain restart claims no change', async () => {
    expect(restartLine(10, RESTARTING)).toBe(
      'The server restarts in 10 seconds. You can join again in about a minute.',
    )
    expect(restartLine(3, RESTARTING)).toBe('Restarting in 3 seconds. See you in a minute.')
    const g = game(two)
    await warnBeforeRestart(g.console, target, RESTARTING, g.pause)
    expect(g.heard.join('\n')).not.toContain('change')
  })

  test('nobody on: no line, no wait', async () => {
    const g = game('There are 0 of a max of 10 players online:')
    expect(await warnBeforeRestart(g.console, target, RESTARTING, g.pause)).toBe(0)
    expect(g.heard).toEqual([LIST_UUIDS])
    expect(g.paused).toEqual([])
  })

  test('a game that doesn’t say who is on delays nothing', async () => {
    for (const answer of [new Error('Connection refused'), 'Unknown or incomplete command']) {
      const g = game(answer)
      expect(await warnBeforeRestart(g.console, target, RESTARTING, g.pause)).toBe(0)
      expect(g.paused).toEqual([])
    }
  })

  test('a line that doesn’t get through still waits out the countdown', async () => {
    const g = game(two, new Error('Connection reset'))
    expect(await warnBeforeRestart(g.console, target, RESTARTING, g.pause)).toBe(2)
    expect(g.paused).toEqual([7000, 3000])
  })

  test(
    'a line that hangs never holds the restart up',
    async () => {
      const g = game(two, HANGS)
      expect(await warnBeforeRestart(g.console, target, RESTARTING, g.pause)).toBe(2)
      expect(g.heard).toEqual([
        LIST_UUIDS,
        announce(restartLine(10, RESTARTING)),
        announce(restartLine(3, RESTARTING)),
      ])
      expect(g.paused).toEqual([7000, 3000])
    },
    SECOND_MS,
  )

  test(
    'a game that hangs before saying who is on holds the restart up only as long as the wait',
    async () => {
      const g = game(HANGS)
      const began = performance.now()
      expect(await warnBeforeRestart(g.console, target, RESTARTING, g.pause, 30)).toBe(0)
      const took = performance.now() - began
      expect(took).toBeGreaterThanOrEqual(25)
      expect(took).toBeLessThan(SECOND_MS)
      expect(g.paused).toEqual([])
    },
    SECOND_MS,
  )

  test('waits for real when no pause is given', async () => {
    const g = game('There are 0 of a max of 10 players online:')
    // Nobody on, so the real wait is never reached: the default is only the clock.
    expect(await warnBeforeRestart(g.console, target, RESTARTING)).toBe(0)
  })
})
