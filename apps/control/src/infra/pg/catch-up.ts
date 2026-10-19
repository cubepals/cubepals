// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which scheduled jobs are run once, as a worker starts: each whose last success is older than its
 * interval, so what a worker that was stopped for hours left stale is fresh now and not at the
 * job's next minute: `/api/health` and the spend watchdog both wait on it. The job then keeps to
 * its schedule (`ticker.ts`). Not for when a job runs otherwise (`CRON` in jobs.ts) or what it does.
 */
import { SECOND_MS } from '@blockly/contracts/durations'

/** The jobs among `schedules` whose last success in `succeeded` is older than their interval at `now`, or that have none. */
export function catchUp(
  schedules: ReadonlyArray<{ job: string; everySeconds: number }>,
  succeeded: ReadonlyMap<string, Date>,
  now: Date,
): string[] {
  return schedules.flatMap(({ job, everySeconds }) => {
    const last = succeeded.get(job)
    return last !== undefined && now.getTime() - last.getTime() <= everySeconds * SECOND_MS ? [] : [job]
  })
}
