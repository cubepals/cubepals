// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** When a server's players hear its owner's notice, and what a notice may say. */
import { describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { messageProblem } from '../revision/revision.ts'
import { dueToSay, SAY_AGAIN_MS } from './notice.ts'

const NOW = new Date('2026-11-08T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

describe('when a notice is said', () => {
  test('to whoever is on the first time, and never to nobody', () => {
    expect(dueToSay(null, ['a'], NOW)).toBe(true)
    expect(dueToSay({ players: [], saidAt: null }, ['a'], NOW)).toBe(true)
    expect(dueToSay(null, [], NOW)).toBe(false)
    expect(dueToSay({ players: ['a'], saidAt: ago(SAY_AGAIN_MS * 3) }, [], NOW)).toBe(false)
  })

  test('again when someone who wasn’t on at the last reading is', () => {
    const last = { players: ['a'], saidAt: ago(MINUTE_MS) }
    expect(dueToSay(last, ['a'], NOW)).toBe(false)
    expect(dueToSay(last, ['a', 'b'], NOW)).toBe(true)
    // Someone leaving is nobody new.
    expect(dueToSay({ players: ['a', 'b'], saidAt: ago(MINUTE_MS) }, ['b'], NOW)).toBe(false)
  })

  test('again every ten minutes while anyone is on', () => {
    expect(SAY_AGAIN_MS).toBe(10 * MINUTE_MS)
    expect(dueToSay({ players: ['a'], saidAt: ago(SAY_AGAIN_MS - 1) }, ['a'], NOW)).toBe(false)
    expect(dueToSay({ players: ['a'], saidAt: ago(SAY_AGAIN_MS) }, ['a'], NOW)).toBe(true)
  })
})

describe('what a notice, like a server’s message, may say', () => {
  test('one line of words that fits the list, with codes', () => {
    expect(messageProblem('&cThis account is under review')).toBeNull()
    expect(messageProblem('&c&l')).not.toBeNull()
    expect(messageProblem('One\nTwo')).not.toBeNull()
    expect(messageProblem('w'.repeat(120))).not.toBeNull()
  })
})
