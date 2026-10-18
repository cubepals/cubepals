// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs once, as a worker starts, each scheduled job whose last success is older than its interval,
 * so what a worker that was stopped for hours left stale is fresh now and not at the job's next
 * minute: `/api/health` and the spend watchdog both wait on it. The job then keeps to its schedule
 * (`ticker.ts`). Not for when a job runs otherwise (`CRON` in jobs.ts) or what it does.
 */
import { MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import type { PgBoss } from 'pg-boss'

/**
 * Marks a catch-up send, so the minute's slot the ticker sends in doesn't drop it. Its own slot is
 * a minute: workers that start together send one between them, and one that restarts later is not
 * held off by a pass that failed.
 */
const CATCH_UP_KEY = 'catch-up'

/**
 * Sends each of `schedules` whose last success in `succeeded` is older than its interval at `now`,
 * or that has none, and wakes `workers` so they fetch at once rather than wait for word of it.
 * Returns the jobs sent.
 */
export async function catchUp(
  boss: Pick<PgBoss, 'send' | 'notifyWorker'>,
  schedules: ReadonlyArray<{ job: string; everySeconds: number }>,
  succeeded: ReadonlyMap<string, Date>,
  workers: readonly string[],
  now: Date,
): Promise<string[]> {
  const sent: string[] = []
  for (const { job, everySeconds } of schedules) {
    const last = succeeded.get(job)
    if (last !== undefined && now.getTime() - last.getTime() <= everySeconds * SECOND_MS) continue
    const id = await boss
      .send(job, {}, { singletonKey: CATCH_UP_KEY, singletonSeconds: MINUTE_S })
      .catch((error: unknown) => {
        console.error(`schedule: ${job} not caught up`, error)
        return null
      })
    if (id !== null) sent.push(job)
  }
  for (const worker of workers) boss.notifyWorker(worker)
  return sent
}
