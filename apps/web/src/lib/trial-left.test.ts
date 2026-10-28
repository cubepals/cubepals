// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What is left of the free trial, and when it is low enough to warn of. */

import { expect, test } from 'bun:test'
import { PLAY_WARNING_AT } from '@blockly/contracts'
import { trialLeft } from './trial-left'

/** Hours left of `hours` with exactly the warning mark's share of them used. */
const atMark = (hours: number) => hours * (1 - PLAY_WARNING_AT / 100)
const trial = (hours: number, hoursLeft: number) => ({ playTotal: { hours, hoursLeft } })

test('a plan with no trial: nothing to say', () => {
  expect(trialLeft({ playTotal: null })).toBeNull()
})

test('its hours left, quiet until the mark, then low', () => {
  expect(trialLeft(trial(20, 12.5))).toEqual({ hoursLeft: 12.5, low: false })
  expect(trialLeft(trial(20, atMark(20) + 0.01))?.low).toBe(false)
  expect(trialLeft(trial(20, atMark(20)))).toEqual({ hoursLeft: atMark(20), low: true })
  expect(trialLeft(trial(20, 0.25))?.low).toBe(true)
})

test('the mark is a share of the plan’s own hours, whatever they are', () => {
  expect(trialLeft(trial(10, atMark(10)))?.low).toBe(true)
  expect(trialLeft(trial(10, atMark(10) + 0.01))?.low).toBe(false)
})

test('a trial that is played: nothing here, the note on resting says it', () => {
  expect(trialLeft(trial(20, 0))).toBeNull()
})
