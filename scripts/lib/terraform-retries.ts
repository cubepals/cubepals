// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Running a Terraform command again after it stopped, for a deploy (`scripts/production.ts`).
 * Fly's API sometimes fails while Terraform reads an app's secrets ("List Secrets Error … deadline
 * exceeded", or a 500 from its token service), which stops a plan or apply before it changes
 * anything. Terraform changes only what differs, so the same command run again rides that out. The
 * waits between tries grow, so an outage of a few minutes is waited out, not only a single slow
 * answer: one of about three minutes outlasted three tries fifteen seconds apart. Not for deciding
 * whether a failure is Fly's: every stop is tried again, and the last one's words stay on screen.
 */
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'

/** The wait before each try after the first: about seven minutes in all. */
export const TERRAFORM_WAITS_MS: readonly number[] = [15 * SECOND_MS, MINUTE_MS, 2 * MINUTE_MS, 4 * MINUTE_MS]

/** How one run ended: its exit status, null where a signal stopped it. */
export interface Ran {
  status: number | null
  signal?: string | null
}

/**
 * Runs `run` until it exits 0, waiting `waits` between tries, and gives back how the last run
 * ended. One stopped by a signal, as a cancelled deploy's is, is never run again.
 */
export function untilItRuns(
  run: () => Ran,
  deps: { wait: (ms: number) => void; say: (line: string) => void; waits?: readonly number[] },
): Ran {
  const waits = deps.waits ?? TERRAFORM_WAITS_MS
  for (let tries = 0; ; tries++) {
    const done = run()
    const next = waits[tries]
    if (done.status === 0 || done.status === null || next === undefined) return done
    deps.say(`stopped (exit ${done.status}); trying again in ${Math.round(next / SECOND_MS)} s.`)
    deps.wait(next)
  }
}
