// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a held join keeps asking for its server's wake: again and again until the server is up, is
 * refused or left asleep, the client leaves, or the hold's time is up. Asks are at least
 * `RETRY_MS` apart, from when each began: an ask the control plane answered at once, or that
 * failed, is followed by a pause; one that already waited its whole window for the server
 * (`wakeWaitMs`, 25 s) is asked again at once, since the pause would only hold the player longer.
 *
 * Not for the ask itself (`wakeOnce` in `agent.ts`, which shares one ask between joins), nor for
 * what the client is told meanwhile (`hold.ts`, `held-words.ts`).
 */
import type { WakeResult } from '@blockly/contracts/edge'

/** The least time between the start of one ask and the next. */
export const RETRY_MS = 2_000

/** What the loop reaches outside itself: the ask, the clock and a pause. */
export interface Asking {
  ask: () => Promise<WakeResult>
  /** Whether the client has gone. */
  gone: () => boolean
  now: () => number
  sleep: (ms: number) => Promise<unknown>
}

/** The last answer, or null where the last ask failed. */
export async function wakeWhile(asking: Asking, deadline: number): Promise<WakeResult | null> {
  for (;;) {
    const askedAt = asking.now()
    const result = await asking.ask().catch(() => null)
    const over = result?.outcome === 'ready' || result?.outcome === 'denied' || result?.outcome === 'asleep'
    if (over || asking.gone() || asking.now() >= deadline) return result
    const pause = RETRY_MS - (asking.now() - askedAt)
    if (pause > 0) await asking.sleep(pause)
  }
}
