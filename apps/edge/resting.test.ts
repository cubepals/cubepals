// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a friend reads at a server resting for its owner's free trial, rendered as the game gets it
 * and measured in the default font against the game's own widths.
 */

import { expect, test } from 'bun:test'
import { LIST_WIDTH, width } from './asleep.ts'
import { turnAway } from './hold.ts'
import { readVarInt } from './notice.ts'
import { REFUSAL_WIDTH, restingJoin, restingStatus } from './resting.ts'

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

test('a friend turned away after the free trial hears whose server, that it rests for now, and that they will know', () => {
  expect(rendered(restingJoin('Sunset Valley'))).toEqual([
    '“Sunset Valley” is resting for now',
    'Its owner’s free trial is used up.',
    'They’ll see on Cubepals that you came by.',
  ])
})

test('every line fits the disconnect screen unwrapped, at the smallest screen the game draws', () => {
  const lines = rendered(restingJoin('Sunset Valley'))
  for (const line of lines) expect(width(line)).toBeLessThanOrEqual(REFUSAL_WIDTH)
  expect(lines.length).toBeLessThanOrEqual(4)
})

test('a name too wide for its line, or with formatting codes, is not shown as the owner typed it', () => {
  const long = 'The Most Wonderful Castle Under the Mountain Range'
  expect(rendered(restingJoin(long))[0]).toBe('This server is resting for now')
  expect(rendered(restingJoin('§4Red §lKeep'))[0]).toBe('“Red Keep” is resting for now')
  expect(rendered(restingJoin(undefined))[0]).toBe('This server is resting for now')
})

test('nothing a friend reads says midnight, a time of day, or that they did something wrong', () => {
  const words = [restingJoin('A'), restingStatus(undefined)].join(' ')
  expect(words).not.toMatch(/midnight|\d:\d\d|your |you can’t|not allowed|denied/i)
})

test('the server list says it rests, under the server’s own message', () => {
  expect(restingStatus(undefined)).toBe('Resting for now')
  expect(restingStatus('§6Sunset Valley')).toBe('§6Sunset Valley\n§r§7Resting for now')
  for (const line of restingStatus('§6Sunset Valley').split('\n'))
    expect(width(line)).toBeLessThanOrEqual(LIST_WIDTH)
})
