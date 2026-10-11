// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Asks the Docker daemon again when its answer never ends. Bun's node:http client, which dockerode
 * speaks through, now and then takes in the whole of a streamed reply (a wait's exit code, a stopped
 * container's log; a pull's progress is streamed the same way) and never ends it, so the call would
 * hang for good, and aborting it doesn't end it either. It does not decide which calls are safe
 * to ask twice: each caller does, and only calls that give the same answer when asked again
 * belong here.
 */

/** What one ask is handed: the signal that drops it, and a way to say a stream is still moving. */
export type Ask = {
  signal: AbortSignal
  /** A stream's sign of life (a pull's progress line): its time to end starts over. */
  alive: () => void
}

/** How long the first ask has to end, and the longest any one ask is given. */
type Pace = { firstMs: number; longestMs: number }
const PACE: Pace = { firstMs: 10_000, longestMs: 2 * 60 * 1000 }

/**
 * A call asked again when it doesn't end. Each ask is given twice as long as the one before, up to
 * a ceiling, counted from its start or from its last sign of life; one that hasn't ended by then is
 * dropped and asked again. `within` gives up altogether: the current ask is dropped and the call
 * fails with the signal's reason.
 */
export async function reasked<T>(
  call: (ask: Ask) => Promise<T>,
  within?: AbortSignal,
  pace: Pace = PACE,
): Promise<T> {
  for (let ms = pace.firstMs; ; ms = Math.min(ms * 2, pace.longestMs)) {
    within?.throwIfAborted()
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let open = true
    let late: () => void = () => undefined
    const overdue = new Promise<null>((resolve) => {
      late = () => resolve(null)
    })
    const alive = () => {
      if (!open) return
      clearTimeout(timer)
      timer = setTimeout(late, ms)
    }
    alive()
    within?.addEventListener('abort', late, { once: true })
    const asked = call({ signal: abort.signal, alive })
    try {
      const answer = await Promise.race([asked.then((value) => ({ value })), overdue])
      if (answer !== null) return answer.value
    } finally {
      open = false
      clearTimeout(timer)
      within?.removeEventListener('abort', late)
    }
    // The dropped ask fails once aborted, if it ever settles; nothing waits on it any more.
    asked.catch(() => undefined)
    abort.abort()
  }
}
