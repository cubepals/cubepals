// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A sleeping server's line in the server list: its own message, the wake line, and the width. */

import { expect, test } from 'bun:test'
import { asleepMessage, LIST_WIDTH, oneLine, width } from './asleep.ts'

const NOTICE = 'Sleeping · join to wake it up'

test('a sleeping server shows its own message, then that a join wakes it', () => {
  expect(asleepMessage('§6Sunset §lValley §r· come build', NOTICE)).toBe(
    `§6Sunset §lValley §r· come build\n§r§7${NOTICE}`,
  )
})

test('a server with no message of its own shows the notice alone', () => {
  expect(asleepMessage(undefined, NOTICE)).toBe(NOTICE)
  expect(asleepMessage('  ', NOTICE)).toBe(NOTICE)
})

test('the wake line fits the list on its own line, in grey', () => {
  const [, second] = asleepMessage('A message', NOTICE).split('\n')
  expect(second).toBe(`§r§7${NOTICE}`)
  expect(width(second ?? '')).toBeLessThanOrEqual(LIST_WIDTH)
})

test('a message too wide for one line is cut with an ellipsis, so the wake line stays in sight', () => {
  // 59 characters, the longest a message may be, and bold: far wider than the list.
  const long = `§a§l${'W'.repeat(59)}`
  const line = oneLine(long)
  expect(line.startsWith('§a§lWWW')).toBe(true)
  expect(line.endsWith('…')).toBe(true)
  expect(width(line)).toBeLessThanOrEqual(LIST_WIDTH)
  expect(asleepMessage(long, NOTICE).split('\n')).toEqual([line, `§r§7${NOTICE}`])
})

test('a cut keeps every code whole, and drops none before the cut', () => {
  const message = `§cRed §9blue ${'§e'.repeat(3)}${'m'.repeat(50)}`
  const line = oneLine(message)
  expect(line).toStartWith('§cRed §9blue §e§e§e')
  // No section sign is left without its code.
  expect(line.replace(/§[0-9a-fk-or]/g, '')).not.toContain('§')
  expect(width(line)).toBeLessThanOrEqual(LIST_WIDTH)
})

test('a message that fits is left exactly as it is', () => {
  const fits = '§b§lSkyblock§r §7· §eseason 3'
  expect(oneLine(fits)).toBe(fits)
})

test('codes take no room, and bold takes a pixel more a character', () => {
  expect(width('§aabc')).toBe(width('abc'))
  expect(width('§labc')).toBe(width('abc') + 3)
  // A colour ends the bold, as it does in the game.
  expect(width('§la§cbc')).toBe(width('abc') + 1)
})
