// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { fullFor, isTight, type RoomFacts, type RoomRules } from './room.ts'

const room = (patch: Partial<RoomFacts> = {}): RoomFacts => ({
  controls: { maxServers: 40, maxRunningServers: 20 },
  serverCeiling: null,
  global: { servers: 0, running: 0 },
  runtimes: true,
  queuedCreateMs: 0,
  ...patch,
})
const rules: RoomRules = { wakeReserve: 2, createWaitMs: MINUTE_MS, freeShare: 0.5 }
const PAID = true
const FREE = false

describe('room for a new server', () => {
  test('creates stop short of the caps, leaving the reserve to starts and wakes', () => {
    // Twenty may run; two stay for the servers people have, so the eighteenth create is the last.
    expect(fullFor(room({ global: { servers: 17, running: 17 } }), rules, PAID)).toBeNull()
    expect(fullFor(room({ global: { servers: 18, running: 18 } }), rules, PAID)).toBe('running')
    // Servers held, by the smaller of the cap and the runtimes' ceiling, less the reserve.
    expect(fullFor(room({ serverCeiling: 10, global: { servers: 8, running: 0 } }), rules, PAID)).toBe(
      'servers',
    )
    expect(fullFor(room({ serverCeiling: 10, global: { servers: 7, running: 0 } }), rules, PAID)).toBeNull()
  })

  test('free plans fill only their share; paid plans create in the rest', () => {
    // Half of the eighteen places creates may fill: nine.
    const nine = room({ global: { servers: 9, running: 9 } })
    expect(fullFor(nine, rules, FREE)).toBe('running')
    expect(fullFor(nine, rules, PAID)).toBeNull()
    expect(fullFor(room({ global: { servers: 8, running: 8 } }), rules, FREE)).toBeNull()
  })

  test('a runtime with no room, or creates already waiting too long, is full for everyone', () => {
    expect(fullFor(room({ runtimes: false }), rules, PAID)).toBe('runtimes')
    expect(fullFor(room({ queuedCreateMs: 2 * MINUTE_MS }), rules, PAID)).toBe('queue')
    expect(fullFor(room({ queuedCreateMs: MINUTE_MS }), rules, PAID)).toBeNull()
  })
})

describe('tight room', () => {
  test('room is tight past the share of what may run at once', () => {
    expect(isTight(room({ global: { servers: 20, running: 15 } }), 0.75)).toBe(true)
    expect(isTight(room({ global: { servers: 20, running: 14 } }), 0.75)).toBe(false)
  })
})
