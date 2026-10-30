// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { readingLeft } from './reading-pace.ts'

const GB = 1024 ** 3

describe('the time left reading a world', () => {
  test('follows its size, counting down', () => {
    expect(readingLeft(2.1 * GB, 0, 0)).toBe('About 4 minutes left')
    expect(readingLeft(2.1 * GB, 0, 3 * MINUTE_MS)).toBe('About a minute left')
    expect(readingLeft(10 * 1024 ** 2, 0, 0)).toBe('About 10 seconds left')
  })

  test('says so when it runs long, rather than stopping at nothing', () => {
    expect(readingLeft(2.1 * GB, 0, 5 * MINUTE_MS)).toBe('Almost there')
    expect(readingLeft(2.1 * GB, 0, 7 * MINUTE_MS)).toBe('Taking longer than usual for a world this size')
    expect(readingLeft(0, 0, 30 * SECOND_MS)).toBe('Taking longer than usual for a world this size')
  })
})
