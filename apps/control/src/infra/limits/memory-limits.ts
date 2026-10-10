// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { RateLimiterMemory } from 'rate-limiter-flexible'
import type { Limits } from '../../app/ports/limits.ts'

/**
 * Counting in this process, on `rate-limiter-flexible` — the library the field uses for this.
 * It handles the expiry and the races a hand-rolled map gets wrong, and it has a Postgres store
 * for the day these counts need to hold across processes.
 *
 * In memory is deliberate for now: the CDN answers most public reads without reaching Blockly
 * at all, and any one instance refusing its share is enough to blunt a target being hammered.
 */
export class MemoryLimits implements Limits {
  readonly #windowSeconds: number
  readonly #limiters = new Map<number, RateLimiterMemory>()

  constructor(windowMs = 60_000) {
    this.#windowSeconds = Math.max(1, Math.round(windowMs / 1000))
  }

  async allow(key: string, limit: number): Promise<boolean> {
    // One limiter per limit: a limit belongs to the surface rather than to the key.
    let limiter = this.#limiters.get(limit)
    if (limiter === undefined) {
      limiter = new RateLimiterMemory({ points: limit, duration: this.#windowSeconds })
      this.#limiters.set(limit, limiter)
    }
    try {
      await limiter.consume(key, 1)
      return true
    } catch (error) {
      // A refusal is a rejection here. So is a rejection that is not a refusal, a store that
      // could not answer: what this guards is a surface anyone can hammer, and a limiter that
      // lets everything through while it is broken guards nothing. Callers already answer a
      // refusal calmly (busy for a moment), so a broken store costs a few reads, not a page.
      if (!(error instanceof Object && 'msBeforeNext' in error))
        console.warn('limits: the store could not answer, refusing', String(error))
      return false
    }
  }
}
