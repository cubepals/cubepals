// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, spyOn, test } from 'bun:test'
import { RateLimiterMemory } from 'rate-limiter-flexible'
import { MemoryLimits } from './memory-limits.ts'

describe('counting public reads', () => {
  test('counts per key, and lets the next window through', async () => {
    // A one-second window, so the window itself can be watched rather than mocked.
    const limiter = new MemoryLimits(1000)
    expect(await limiter.allow('a', 3)).toBe(true)
    expect(await limiter.allow('a', 3)).toBe(true)
    expect(await limiter.allow('a', 3)).toBe(true)
    expect(await limiter.allow('a', 3)).toBe(false)
    // Another target is its own count.
    expect(await limiter.allow('b', 3)).toBe(true)
    // And the window ends.
    await Bun.sleep(1100)
    expect(await limiter.allow('a', 3)).toBe(true)
  }, 10_000)

  test('two surfaces with different limits are counted apart', async () => {
    const limiter = new MemoryLimits(1000)
    expect(await limiter.allow('same-key', 1)).toBe(true)
    expect(await limiter.allow('same-key', 1)).toBe(false)
    // A surface that allows more still has its own room, even under the same key.
    expect(await limiter.allow('same-key', 5)).toBe(true)
  })

  test('a store that cannot answer refuses, rather than letting everything through', async () => {
    const limiter = new MemoryLimits(1000)
    const consume = spyOn(RateLimiterMemory.prototype, 'consume').mockRejectedValue(new Error('store down'))
    try {
      expect(await limiter.allow('a', 3)).toBe(false)
    } finally {
      consume.mockRestore()
    }
    // Once it answers again, so does the limiter.
    expect(await limiter.allow('a', 3)).toBe(true)
  })
})
