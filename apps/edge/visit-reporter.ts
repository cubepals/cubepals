// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sends the visits the edge saw (`visits.ts`) to the control plane, a batch every second, so a
 * join never waits on it. What can't be sent in three tries is dropped, as is what arrives while
 * the queue is full, and the edge's log says how many once a minute.
 *
 * Not for anything a join depends on: a control plane that is down loses only these reports.
 */

import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'
import type { VisitReport } from '../../packages/contracts/src/join-records.ts'

/** The most reports held for sending. */
const MOST_QUEUED = 1_000
/** The most reports in one request, as the control plane takes them. */
const MOST_PER_BATCH = 200
const TRIES = 3

export class VisitReporter {
  readonly #post: (body: string) => Promise<Response>
  readonly #queue: VisitReport[] = []
  #dropped = 0
  #sending = false

  /** `post` sends a body to `/edge/v1/visits`, as the agent's `control()` does. */
  constructor(post: (body: string) => Promise<Response>, everyMs = SECOND_MS) {
    this.#post = post
    setInterval(() => void this.flush(), everyMs).unref()
    setInterval(() => {
      if (this.#dropped === 0) return
      console.error(`visits: dropped ${this.#dropped} reports`)
      this.#dropped = 0
    }, MINUTE_MS).unref()
  }

  send(report: VisitReport): void {
    if (this.#queue.length >= MOST_QUEUED) this.#dropped++
    else this.#queue.push(report)
  }

  /** Sends what is queued, a batch at a time; a batch that fails three times is dropped. */
  async flush(): Promise<void> {
    if (this.#sending) return
    this.#sending = true
    try {
      while (this.#queue.length > 0) {
        const batch = this.#queue.splice(0, MOST_PER_BATCH)
        if (!(await this.#deliver(JSON.stringify({ reports: batch })))) this.#dropped += batch.length
      }
    } finally {
      this.#sending = false
    }
  }

  async #deliver(body: string): Promise<boolean> {
    for (let tried = 0; tried < TRIES; tried++) {
      const response = await this.#post(body).catch(() => null)
      if (response?.ok) return true
    }
    return false
  }
}
