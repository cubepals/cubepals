// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a friend reads at a server resting for its owner's play, rendered as the game gets it and
 * measured in the default font against the game's own widths.
 */

import { expect, test } from 'bun:test'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { LIST_WIDTH, width } from './asleep.ts'
import { turnAway } from './hold.ts'
import { readVarInt } from './notice.ts'
import { REFUSAL_WIDTH, restingJoin, restingStatus } from './resting.ts'

const now = new Date('2026-10-17T09:54:00Z')
const today = { for: 'today', backAt: new Date(now.getTime() + 14 * HOUR_MS + 6 * MINUTE_MS) } as const
const trial = { for: 'trial' } as const

/** The reason a turned-away join's disconnect packet carries, as the game reads it. */
function rendered(text: string): string[] {
  const bytes = turnAway(text)
  const length = readVarInt(bytes, 0)
  const id = readVarInt(bytes, length?.next ?? 0)
  const size = readVarInt(bytes, id?.next ?? 0)
  if (id?.value !== 0 || size === null) throw new Error('not a login disconnect')
  const json = new TextDecoder().decode(bytes.subarray(size.next, size.next + size.value))
  return (JSON.parse(json) as { text: string }).text.split('\n')
}

test('a friend turned away for the day hears whose server, that it rests, when it is back, and that they will know', () => {
  expect(rendered(restingJoin(today, 'Sunset Valley', now))).toEqual([
    '“Sunset Valley” is resting for today',
    'Its owner’s play for today is used up.',
    'It’s back in 14 h 6 min.',
    'They’ll see on Cubepals that you came by.',
  ])
})

test('a friend turned away after the free trial hears it rests for now, with no time', () => {
  expect(rendered(restingJoin(trial, 'Sunset Valley', now))).toEqual([
    '“Sunset Valley” is resting for now',
    'Its owner’s free trial is used up.',
    'They’ll see on Cubepals that you came by.',
  ])
})

test('every line fits the disconnect screen unwrapped, at the smallest screen the game draws', () => {
  for (const resting of [today, trial]) {
    const lines = rendered(restingJoin(resting, 'Sunset Valley', now))
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(REFUSAL_WIDTH)
    expect(lines.length).toBeLessThanOrEqual(4)
  }
})

test('a name too wide for its line, or with formatting codes, is not shown as the owner typed it', () => {
  const long = 'The Most Wonderful Castle Under the Mountain'
  expect(rendered(restingJoin(today, long, now))[0]).toBe('This server is resting for today')
  expect(rendered(restingJoin(today, '§4Red §lKeep', now))[0]).toBe('“Red Keep” is resting for today')
  expect(rendered(restingJoin(today, undefined, now))[0]).toBe('This server is resting for today')
})

test('nothing a friend reads says midnight, a time of day, or that they did something wrong', () => {
  for (const resting of [today, trial]) {
    const words = [restingJoin(resting, 'A', now), restingStatus(resting, undefined, now)].join(' ')
    expect(words).not.toMatch(/midnight|\d:\d\d|your |you can’t|not allowed|denied/i)
  }
})

test('the server list says it rests and how long for, under the server’s own message', () => {
  expect(restingStatus(today, undefined, now)).toBe('Resting for today · back in 14 h 6 min')
  expect(restingStatus(trial, '§6Sunset Valley', now)).toBe('§6Sunset Valley\n§r§7Resting for now')
  for (const line of restingStatus(today, '§6Sunset Valley', now).split('\n'))
    expect(width(line)).toBeLessThanOrEqual(LIST_WIDTH)
})
