// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Moderation inputs and escalation, exercised directly without starting the control plane. */
import { expect, test } from 'bun:test'
import { DAY_MS, HOUR_MS, MINUTE_MS } from './durations.ts'
import {
  DEFAULT_LADDER,
  LiftInput,
  MODERATION_KINDS,
  MODERATION_LENGTHS,
  nextStep,
  PunishInput,
  SetLadderInput,
  SetModerationInput,
} from './moderation.ts'

const serverId = crypto.randomUUID()
const punishment = {
  serverId,
  playerUuid: crypto.randomUUID(),
  name: '  Player  ',
  reason: '  Spam  ',
  kind: 'mute',
  minutes: HOUR_MS / MINUTE_MS,
}

test('the offered lengths and default escalation retain their order and durations', () => {
  const hour = HOUR_MS / MINUTE_MS
  const day = DAY_MS / MINUTE_MS
  expect(MODERATION_KINDS).toEqual(['warn', 'mute', 'ban'])
  expect(MODERATION_LENGTHS).toEqual([hour, day, 7 * day, 30 * day, null])
  expect(DEFAULT_LADDER).toEqual([
    { kind: 'warn', minutes: null },
    { kind: 'mute', minutes: hour },
    { kind: 'mute', minutes: day },
    { kind: 'ban', minutes: 7 * day },
    { kind: 'ban', minutes: null },
  ])
})

test('punishments trim player text, normalize warnings and permit permanent bans', () => {
  expect(PunishInput.parse(punishment)).toEqual({ ...punishment, name: 'Player', reason: 'Spam' })
  expect(PunishInput.parse({ ...punishment, kind: 'warn' }).minutes).toBeNull()
  expect(PunishInput.parse({ ...punishment, kind: 'ban', minutes: null }).minutes).toBeNull()
  expect(PunishInput.parse({ ...punishment, reason: '' }).reason).toBe('')
  expect(PunishInput.parse({ ...punishment, minutes: 1 }).minutes).toBe(1)
  const year = (365 * DAY_MS) / MINUTE_MS
  expect(PunishInput.parse({ ...punishment, minutes: year }).minutes).toBe(year)
  for (const minutes of [0, -1, 1.5, year + 1]) {
    expect(PunishInput.safeParse({ ...punishment, minutes }).success).toBe(false)
  }
  for (const patch of [
    { kind: 'unknown' },
    { name: '   ' },
    { name: 'a'.repeat(65) },
    { reason: 'a'.repeat(121) },
    { playerUuid: 'invalid' },
    { serverId: 'invalid' },
  ])
    expect(PunishInput.safeParse({ ...punishment, ...patch }).success).toBe(false)
})

test('settings and lifts validate their own identifiers and boolean values', () => {
  const settings = { serverId, enabled: false, chatFilter: true, requestId: crypto.randomUUID() }
  expect(SetModerationInput.parse(settings)).toEqual(settings)
  for (const patch of [{ serverId: 'bad' }, { requestId: 'bad' }, { enabled: 1 }, { chatFilter: 'yes' }]) {
    expect(SetModerationInput.safeParse({ ...settings, ...patch }).success).toBe(false)
  }
  const lift = { serverId, actionId: crypto.randomUUID() }
  expect(LiftInput.parse(lift)).toEqual(lift)
  expect(LiftInput.safeParse({ ...lift, actionId: 'bad' }).success).toBe(false)
  expect(LiftInput.safeParse({ ...lift, serverId: 'bad' }).success).toBe(false)
})

test('an owner can reset the ladder or supply one through ten validated steps', () => {
  expect(SetLadderInput.parse({ serverId, ladder: null }).ladder).toBeNull()
  const step = { kind: 'warn', minutes: 1 }
  expect(SetLadderInput.parse({ serverId, ladder: [step] }).ladder).toEqual([{ kind: 'warn', minutes: null }])
  expect(SetLadderInput.parse({ serverId, ladder: Array(10).fill(step) }).ladder).toHaveLength(10)
  for (const ladder of [[], Array(11).fill(step), [{ kind: 'unknown', minutes: null }]]) {
    expect(SetLadderInput.safeParse({ serverId, ladder }).success).toBe(false)
  }
  expect(SetLadderInput.safeParse({ serverId: 'bad', ladder: null }).success).toBe(false)
})

test('only offences that have not been lifted advance the ladder, whose last step repeats', () => {
  expect(nextStep(DEFAULT_LADDER, [])).toEqual(DEFAULT_LADDER[0]!)
  for (const status of ['waiting', 'given', 'over'] as const) {
    expect(nextStep(DEFAULT_LADDER, [{ status }])).toEqual(DEFAULT_LADDER[1]!)
  }
  for (const status of ['lifting', 'lifted'] as const) {
    expect(nextStep(DEFAULT_LADDER, [{ status }])).toEqual(DEFAULT_LADDER[0]!)
  }
  expect(nextStep(DEFAULT_LADDER, [{ status: 'given' }, { status: 'over' }, { status: 'lifted' }])).toEqual(
    DEFAULT_LADDER[2]!,
  )
  expect(nextStep(DEFAULT_LADDER, Array(20).fill({ status: 'given' }))).toEqual(DEFAULT_LADDER.at(-1)!)
  expect(nextStep([], [])).toEqual({ kind: 'warn', minutes: null })
})
