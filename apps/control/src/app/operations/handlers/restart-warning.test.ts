// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The countdown players read before a restart: to whoever is on, and to nobody otherwise. */
import { describe, expect, test } from 'bun:test'
import { announce, LIST_UUIDS } from '../../../minecraft/console.ts'
import type { ConsoleTarget } from '../../ports/minecraft.ts'
import { COUNTDOWN, restartLine, warnBeforeRestart } from './restart-warning.ts'

const target: ConsoleTarget = { endpoint: { host: 'game.test', port: 25575 }, passwords: ['secret'] }

/** A game console that answers `list uuids` as given, and records every command and pause. */
const game = (answer: string | Error, failsAnnounce = false) => {
  const heard: string[] = []
  const paused: number[] = []
  const console = {
    run: async (to: ConsoleTarget, command: string) => {
      expect(to).toBe(target)
      heard.push(command)
      if (command === LIST_UUIDS) {
        if (answer instanceof Error) throw answer
        return answer
      }
      if (failsAnnounce) throw new Error('Connection reset')
      return ''
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
    expect(await warnBeforeRestart(g.console, target, g.pause)).toBe(2)
    expect(g.heard).toEqual([LIST_UUIDS, announce(restartLine(10)), announce(restartLine(3))])
    expect(g.paused).toEqual([7000, 3000])
  })

  test('says why, and when they can come back', () => {
    expect(COUNTDOWN).toEqual([10, 3])
    expect(restartLine(10)).toBe(
      'The server restarts in 10 seconds for a change its owner made. You can join again in about a minute.',
    )
    expect(restartLine(3)).toBe('Restarting in 3 seconds. See you in a minute.')
  })

  test('nobody on: no line, no wait', async () => {
    const g = game('There are 0 of a max of 10 players online:')
    expect(await warnBeforeRestart(g.console, target, g.pause)).toBe(0)
    expect(g.heard).toEqual([LIST_UUIDS])
    expect(g.paused).toEqual([])
  })

  test('a game that doesn’t say who is on delays nothing', async () => {
    for (const answer of [new Error('Connection refused'), 'Unknown or incomplete command']) {
      const g = game(answer)
      expect(await warnBeforeRestart(g.console, target, g.pause)).toBe(0)
      expect(g.paused).toEqual([])
    }
  })

  test('a line that doesn’t get through still waits out the countdown', async () => {
    const g = game(two, true)
    expect(await warnBeforeRestart(g.console, target, g.pause)).toBe(2)
    expect(g.paused).toEqual([7000, 3000])
  })

  test('waits for real when no pause is given', async () => {
    const g = game('There are 0 of a max of 10 players online:')
    // Nobody on, so the real wait is never reached: the default is only the clock.
    expect(await warnBeforeRestart(g.console, target)).toBe(0)
  })
})
