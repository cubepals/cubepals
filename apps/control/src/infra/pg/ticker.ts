// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sends each scheduled job as its minute comes (`CRON` in jobs.ts), from every process that works
 * the queues, in place of pg-boss's own scheduler. pg-boss's reads every schedule on each pass and
 * sends what is due through a queue of its own, about 12 kB a minute for nothing that can't be
 * known here. Each worker sends what is due at a second past each minute; the job's minute is its
 * singleton slot (`singletonSeconds`), so two workers, as a rolling deploy runs, send one job
 * between them, and a minute nobody was running for is skipped, as pg-boss's `missed: 'skip'` did.
 * Not for what a job does (`app/scheduled-jobs.ts`).
 */
import { MINUTE_MS, MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import type { PgBoss } from 'pg-boss'

/** How far into each minute the jobs go: clear of where the database's minute and this one's part. */
const INTO_MINUTE_MS = SECOND_MS

/** The fields of a cron expression, in order, with the values each takes. */
const FIELDS = [
  { name: 'minute', min: 0, max: 59, of: (at: Date) => at.getUTCMinutes() },
  { name: 'hour', min: 0, max: 23, of: (at: Date) => at.getUTCHours() },
  { name: 'day of month', min: 1, max: 31, of: (at: Date) => at.getUTCDate() },
  { name: 'month', min: 1, max: 12, of: (at: Date) => at.getUTCMonth() + 1 },
  { name: 'day of week', min: 0, max: 6, of: (at: Date) => at.getUTCDay() },
] as const

/**
 * Whether a five-field cron expression, read in UTC as pg-boss read ours, names `at`'s minute.
 * It reads what `CRON` writes: `*`, `*\/n`, a number, and lists of them. Anything else throws, so
 * a schedule written another way is refused as a worker starts rather than never sent.
 */
export function due(cron: string, at: Date): boolean {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== FIELDS.length) throw new Error(`Not a five-field cron expression: ${cron}`)
  return FIELDS.every((field, i) => {
    const value = field.of(at)
    return (parts[i] ?? '').split(',').some((term) => {
      if (term === '*') return true
      const step = /^\*\/(\d+)$/.exec(term)
      if (step) return (value - field.min) % Number(step[1]) === 0
      if (!/^\d+$/.test(term) || Number(term) < field.min || Number(term) > field.max)
        throw new Error(`Cron ${cron}: ${field.name} ${term} is not read here`)
      return value === Number(term)
    })
  })
}

/**
 * Sends each of `schedules` (job name and cron) as its minute comes, until the returned function
 * is called. Every expression is read once first, so one that can't be refuses at once.
 */
export function everyMinute(boss: PgBoss, schedules: ReadonlyArray<readonly [string, string]>): () => void {
  for (const [, cron] of schedules) due(cron, new Date(0))
  const send = async (at: Date) => {
    for (const [name, cron] of schedules) {
      if (!due(cron, at)) continue
      await boss
        .send(name, {}, { singletonSeconds: MINUTE_S })
        .catch((error: unknown) => console.error(`schedule: ${name} not sent`, error))
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const next = () => {
    if (stopped) return
    const now = Date.now()
    const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS
    const at = minute + INTO_MINUTE_MS > now ? minute : minute + MINUTE_MS
    timer = setTimeout(
      () => {
        void send(new Date(at)).finally(next)
      },
      at + INTO_MINUTE_MS - now,
    )
    timer.unref()
  }
  next()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
