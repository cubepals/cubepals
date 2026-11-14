// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a test waits: for what it waits on, never for a length of time (AGENTS.md, Structure,
 * "Sleeps"). A test that sleeps and then looks passes on the machine it was written on
 * and fails on a busier one; one that waits for the thing itself takes as long as the thing, and
 * when the thing never comes it says what it waited for and what it saw instead. The one wait on
 * time is `stays`, which shows that something did not happen. check-structure.ts's `sleeps` check
 * holds test files to these. For tests: nothing a server runs imports it.
 */
import { SECOND_MS } from './durations.ts'

/** How often a wait looks again. */
const EVERY_MS = 50

export interface Seen {
  /** What the test saw, for a failure to say. */
  seen?: () => string
}

/** The runtime's timers: contracts carries no runtime's types, and every runtime a test runs in has them. */
declare function setTimeout(callback: () => void, ms: number): unknown
declare function clearTimeout(timer: unknown): void

type Check = () => boolean | Promise<boolean>

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const saying = (options: Seen) => (options.seen ? `\n${options.seen()}` : '')

/** One look at `check`, given at most `ms` to answer: its answer, or 'late' when it gave none in time. */
async function look(check: Check, ms: number): Promise<boolean | 'late'> {
  let timer: unknown
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), Math.max(ms, 0))
  })
  try {
    return await Promise.race([Promise.resolve().then(check), late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Waits until `check` holds, looking again every 50 ms, for up to `timeoutMs` (15 s unless given);
 * then fails, naming `what` and saying what the test saw. An async check that hangs is held to the
 * same deadline.
 */
export async function until(
  what: string,
  check: Check,
  options: Seen & { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 15 * SECOND_MS)
  for (;;) {
    const answer = await look(check, deadline - Date.now())
    if (answer === true) return
    if (answer === 'late' || Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${what}${saying(options)}`)
    await pause(EVERY_MS)
  }
}

/**
 * That `check` holds all through `ms`, looking every 50 ms: the one wait on time, to show that
 * something didn't happen. It fails as soon as `check` stops holding, naming `what`, and when an
 * async check gives no answer by the end, since then nothing showed that it held.
 */
export async function stays(what: string, check: Check, ms: number, options: Seen = {}): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    if ((await look(check, Math.max(end - Date.now(), EVERY_MS))) !== true)
      throw new Error(`Expected ${what} to hold for ${ms} ms${saying(options)}`)
    const left = end - Date.now()
    if (left <= 0) return
    await pause(Math.min(EVERY_MS, left))
  }
}
