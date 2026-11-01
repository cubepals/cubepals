// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The player-removal protocol and the owner's switch inputs retain their public contract. */
import { expect, test } from 'bun:test'
import {
  REMOVAL_MESSAGES,
  REMOVAL_REASONS,
  SetStopCheatersInput,
  UseOurStopCheatersInput,
} from './stop-cheaters.ts'

test('each removal reason retains its player-facing explanation', () => {
  expect(REMOVAL_REASONS).toEqual(['movement', 'speed', 'impossible'])
  expect(REMOVAL_MESSAGES).toEqual({
    movement: 'Removed for moving in a way the game can’t. You can rejoin.',
    speed: 'Removed for moving faster than the game allows. You can rejoin.',
    impossible: 'Removed for sending something the game can’t. You can rejoin.',
  })
})

test('switch and takeover requests validate the server, deliberate request and boolean value', () => {
  const base = { serverId: crypto.randomUUID(), requestId: crypto.randomUUID() }
  for (const on of [true, false]) expect(SetStopCheatersInput.parse({ ...base, on })).toEqual({ ...base, on })
  expect(UseOurStopCheatersInput.parse(base)).toEqual(base)
  for (const patch of [{ serverId: 'bad' }, { requestId: 'bad' }]) {
    expect(SetStopCheatersInput.safeParse({ ...base, on: true, ...patch }).success).toBe(false)
    expect(UseOurStopCheatersInput.safeParse({ ...base, ...patch }).success).toBe(false)
  }
  expect(SetStopCheatersInput.safeParse({ ...base, on: 'yes' }).success).toBe(false)
})
