// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the platform's recurring work last went (`job_health`): what the worker writes of each
 * scheduled job's pass (`infra/pg/jobs.ts` calls it), and what counts as a job that keeps failing
 * or has gone quiet. The `jobs_failing` alert and `/api/health` judge by these; the SQL is
 * `persistence.ts`'s. It doesn't run anything or decide what to do about a failing job.
 */
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import type { JobOutcomes, ScheduledJob, WorkerHeartbeat } from '../ports/jobs.ts'
import { type JobHealthRecord, recordJobFailed, recordJobSucceeded, recordSchedule } from './persistence.ts'

/** Failures in a row that make a job one that keeps failing. */
export const FAILING_IN_A_ROW = 3
/** Intervals a job may go without a success before it counts as quiet. */
const QUIET_INTERVALS = 3
/** The sweeps `/api/health` holds the control plane to: the worker beating, alerts, spend. */
export const KEY_SWEEPS = [
  'worker-heartbeat',
  'admin-alerts',
  'spend-watchdog',
] as const satisfies ReadonlyArray<ScheduledJob | WorkerHeartbeat>

/** Since when a job has gone without a success: its last, or when it was first seen. */
export const quietSince = (row: JobHealthRecord): Date => row.lastSucceededAt ?? row.firstSeenAt

/** A scheduled job with no success in three of its intervals. */
export const overdue = (row: JobHealthRecord, now: Date): boolean =>
  row.everySeconds !== null &&
  now.getTime() - quietSince(row).getTime() > QUIET_INTERVALS * row.everySeconds * SECOND_MS

/** What the worker writes of each scheduled pass, and whether this process's passes still go. */
export class JobRecord implements JobOutcomes {
  readonly #db: Db
  /** This process's last recorded success, or its start. */
  #lastPass = new Date()

  constructor(deps: { db: Db }) {
    this.#db = deps.db
  }

  async scheduled(jobs: ReadonlyArray<{ job: string; everySeconds: number }>, at: Date): Promise<void> {
    this.#lastPass = at
    await recordSchedule(this.#db, jobs, at)
  }

  async succeeded(job: string, at: Date): Promise<void> {
    await recordJobSucceeded(this.#db, job, at)
    this.#lastPass = at
  }

  async failed(job: string, at: Date, error: string): Promise<void> {
    await recordJobFailed(this.#db, job, at, error)
  }

  /**
   * Whether this worker's schedules still run: a success recorded within three heartbeats. A
   * worker whose queue or database has wedged stops recording them, and Fly's check on the worker
   * group (`infra/fly/control.toml`) sees it.
   */
  beating(now = new Date()): boolean {
    return now.getTime() - this.#lastPass.getTime() <= QUIET_INTERVALS * MINUTE_MS
  }
}
