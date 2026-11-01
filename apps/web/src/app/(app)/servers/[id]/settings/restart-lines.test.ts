// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The words around a restart: who is on, what each choice does, and what waits. */
import { describe, expect, test } from 'bun:test'
import type { ServerView } from '@blockly/contracts'
import { occupied, onlineLine, WHEN_SAID, waitingLines } from './restart-lines'

const people = (...names: string[]) => names.map((name, i) => ({ name, uuid: `uuid-${i}` }))
const view = (online: number, names: string[] = [], status: ServerView['status'] = 'running') =>
  ({ status, players: { online, people: people(...names) } }) as Pick<ServerView, 'status' | 'players'>

describe('who a restart would drop', () => {
  test('only someone on a running server', () => {
    expect(occupied(view(2, ['Alex', 'Sam']))).toBe(true)
    expect(occupied(view(0))).toBe(false)
    expect(occupied(view(2, ['Alex', 'Sam'], 'stopped'))).toBe(false)
    expect(occupied({ status: 'running', players: null })).toBe(false)
  })

  test('named, up to three, then counted', () => {
    expect(onlineLine(view(1, ['Alex']))).toBe('Alex is online.')
    expect(onlineLine(view(2, ['Alex', 'Sam']))).toBe('Alex and Sam are online.')
    expect(onlineLine(view(3, ['Alex', 'Sam', 'Kim']))).toBe('Alex, Sam and Kim are online.')
    expect(onlineLine(view(4, ['Alex', 'Sam', 'Kim', 'Jo']))).toBe('Alex, Sam, Kim and 1 other are online.')
    expect(onlineLine(view(6, ['Alex', 'Sam', 'Kim', 'Jo']))).toBe('Alex, Sam, Kim and 3 others are online.')
  })

  test('counted where the server hasn’t said who', () => {
    expect(onlineLine(view(1))).toBe('1 player is online.')
    expect(onlineLine(view(3))).toBe('3 players are online.')
    expect(onlineLine(view(2, ['Alex']))).toBe('Alex and 1 other are online.')
  })

  test('nothing to say with nobody on', () => {
    expect(onlineLine(view(0))).toBeNull()
    expect(onlineLine(view(2, ['Alex', 'Sam'], 'stopped'))).toBeNull()
  })

  test('each choice says what it does to them', () => {
    expect(WHEN_SAID.empty.label).toBe('When everyone leaves')
    expect(WHEN_SAID.empty.line).toStartWith('Nobody is sent away.')
    expect(WHEN_SAID.now.label).toBe('Restart now')
    expect(WHEN_SAID.now.line).toContain('10-second countdown')
  })
})

describe('what waits for everyone to leave', () => {
  const present = (change: { field: string }) => `changed ${change.field}`

  test('configuration as History words it, then the size, then Stop cheaters', () => {
    expect(
      waitingLines(
        {
          changes: [{ field: 'viewDistance', from: 10, to: 6 }],
          size: { from: '3 GB', to: '4 GB' },
          stopCheaters: 'on',
        },
        present,
      ),
    ).toEqual(['changed viewDistance', 'Size 3 GB → 4 GB', 'Stop cheaters turns on'])
  })

  test('each of Stop cheaters’ changes in its own words', () => {
    const only = (stopCheaters: 'on' | 'off' | 'ours' | null) =>
      waitingLines({ changes: [], size: null, stopCheaters }, present)
    expect(only('off')).toEqual(['Stop cheaters turns off'])
    expect(only('ours')).toEqual(['Stop cheaters uses Cubepals’ settings in place of yours'])
    expect(only(null)).toEqual([])
  })
})
