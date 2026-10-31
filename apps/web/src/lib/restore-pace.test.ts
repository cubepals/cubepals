// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A restore's countdown against what production measured bringing back a 2.1 GB uploaded world:
 * the estimate itself (`restore-pace.ts`), and what the restore's card says on the way.
 */
import { describe, expect, test } from 'bun:test'
import type { OperationView } from '@blockly/contracts'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { etaLine, presentProgress } from './present.ts'
import { restoreSeconds } from './restore-pace.ts'

const GB = 1024 ** 3
const vanilla = { gameVersion: '26.3', modCount: 0, modpack: null }
const started = '2026-10-31T00:58:08Z'

/** A restore under way since `started`, of a world of `worldBytes`. */
const restoring = (worldBytes: number | null): OperationView => ({
  id: 'op',
  kind: 'restore',
  change: null,
  worldBytes,
  broughtWorld: null,
  status: 'running',
  step: 'storage',
  error: null,
  createdAt: started,
  startedAt: started,
})

/** What the restore's card says this long after it began. */
const after = (worldBytes: number | null, ms: number) => {
  const progress = presentProgress(restoring(worldBytes), vanilla)
  if (progress === null) throw new Error('a restore shows its progress')
  return etaLine(started, progress.expectedSeconds, Date.parse(started) + ms)
}

describe('how long a restore takes', () => {
  test('a 2.1 GB world takes about the five and a half minutes production measured', () => {
    // 101 s keeping the world it replaced, 142 s fetching it, 84 s starting it up.
    expect(Math.abs(restoreSeconds(2.1 * GB) - 327)).toBeLessThan(15)
  })

  test('grows with the world it fetches, and a snapshot fetches nothing', () => {
    expect(restoreSeconds(2 * GB)).toBeGreaterThan(restoreSeconds(GB))
    expect(restoreSeconds(GB) - restoreSeconds(0)).toBeGreaterThan(55)
    expect(restoreSeconds(null)).toBe(restoreSeconds(0))
  })

  test('the card counts down from the world it brings back', () => {
    expect(presentProgress(restoring(2.1 * GB), vanilla)?.expectedSeconds).toBe(restoreSeconds(2.1 * GB))
    expect(presentProgress(restoring(null), vanilla)?.expectedSeconds).toBe(restoreSeconds(null))
  })

  test('a big world on pace is never longer than usual', () => {
    expect(after(2.1 * GB, 0)).toBe('A few minutes left')
    // Where production's was, fetching the world, past its first minute.
    expect(after(2.1 * GB, 2 * MINUTE_MS)).toBe('A few minutes left')
    expect(after(2.1 * GB, 4 * MINUTE_MS)).toBe('About a minute left')
    expect(after(2.1 * GB, 5 * MINUTE_MS + 30 * SECOND_MS)).toBe('Almost there')
  })

  test('says so once even a big world runs long', () => {
    expect(after(2.1 * GB, 7 * MINUTE_MS)).toBe('Taking a little longer than usual')
  })
})
