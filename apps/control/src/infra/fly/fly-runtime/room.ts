// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Waiting for a machine while the organization holds as many as Fly lets it. Work that needs one
 * more for a while (a restore's or a move's new machine, a helper) asks again, with pauses that
 * double, until one frees. How many servers the limit holds is `serverCeilingOf`'s.
 */

import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { RuntimeAtLimit } from '../../../app/ports/runtime.ts'

/** Pauses that double from `firstMs` to `maxMs`, for `forMs` in all. */
export interface RoomWait {
  firstMs: number
  maxMs: number
  forMs: number
}

/** Short of the half hour an operation has, so what the work does after it still fits. */
export const ROOM_WAIT: RoomWait = { firstMs: 5 * SECOND_MS, maxMs: MINUTE_MS, forMs: 15 * MINUTE_MS }

/**
 * `make`, again and again while Fly refuses it for the organization's limit, until a machine
 * frees; `waiting` says so once. With none freed in all of `wait`, `refused` clears what the work
 * made for it, and RuntimeAtLimit is thrown: Fly's limit is never a failed server.
 */
export async function whenRoom<T>(
  wait: RoomWait,
  make: () => Promise<T>,
  on: { waiting?: () => Promise<unknown>; refused?: () => Promise<unknown> } = {},
): Promise<T> {
  const until = Date.now() + wait.forMs
  let pause = wait.firstMs
  for (let attempt = 0; ; attempt++) {
    try {
      return await make()
    } catch (error) {
      if (!(error instanceof RuntimeAtLimit)) throw error
      if (Date.now() + pause > until) {
        await on.refused?.()
        throw error
      }
      if (attempt === 0) await on.waiting?.()
    }
    await new Promise((resolve) => setTimeout(resolve, pause))
    pause = Math.min(pause * 2, wait.maxMs)
  }
}
