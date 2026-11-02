// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { modCheckTiming } from './mod-check-timing.ts'

const epoch = Date.parse('2026-11-02T00:00:00Z')
const step = (name: string, seconds: number) => ({
  step: name,
  at: new Date(epoch + seconds * SECOND_MS).toISOString(),
})

test('a check has no duration until the worker moves on, then uses its actual boundaries', () => {
  expect(modCheckTiming(null)).toEqual({})
  expect(modCheckTiming([])).toEqual({})
  expect(modCheckTiming([step('compute', 0)])).toEqual({})
  expect(modCheckTiming([step('checking_mods', 2)])).toEqual({ modCheckSeconds: null })
  expect(modCheckTiming([step('attempt', 0), step('checking_mods', 2), step('compute', 93)])).toEqual({
    modCheckSeconds: 91,
  })
  expect(modCheckTiming([step('checking_mods', 2), step('compute', 1)])).toEqual({ modCheckSeconds: 0 })
})

test('retries discard earlier attempt time and multiple checks count only their own spans', () => {
  expect(
    modCheckTiming([
      step('attempt', 0),
      step('checking_mods', 2),
      step('attempt', 300),
      step('checking_mods', 301),
      step('saving', 305),
      step('checking_mods', 308),
      step('compute', 310),
    ]),
  ).toEqual({ modCheckSeconds: 6 })
  expect(modCheckTiming([step('checking_mods', 0), step('compute', 10), step('attempt', 300)])).toEqual({})
  expect(modCheckTiming([step('checking_mods', 0), step('compute', 10), step('checking_mods', 12)])).toEqual({
    modCheckSeconds: null,
  })
})
