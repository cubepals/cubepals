// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Refusal readers preserve unknown and absent responses instead of manufacturing a retry reason. */
import { expect, test } from 'bun:test'
import {
  saysBound,
  saysClaimed,
  saysNotYet,
  saysReplacing,
  scheduledAt,
  snapshotScheduled,
} from './refusals.ts'

test('absent or unrelated errors do not claim a recognized provider state', () => {
  for (const error of [null, undefined, '', new Error('unrelated failure')]) {
    for (const read of [saysBound, saysClaimed, saysNotYet, saysReplacing]) expect(read(error)).toBe(false)
    expect(scheduledAt(error)).toBeNull()
  }
  const at = '2026-11-02T00:00:00Z'
  expect(scheduledAt(snapshotScheduled(at))).toBe(Date.parse(at))
  expect(scheduledAt(snapshotScheduled('invalid'))).toBeNull()
})
