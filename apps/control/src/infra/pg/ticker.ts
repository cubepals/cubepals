// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Starts each scheduled job's pass as its minute comes (`CRON` in jobs.ts), from every process that
 * works the queues. A pass is taken, not sent: one statement a minute takes every pass due for
 * this process (`JobOutcomes.claim`), and what it takes is run here, with no job in the queue
 * between. The claim is how two workers, as a rolling deploy runs, run a pass between them once, and
 * how a pass that outlasts its minute is not started again; a minute nobody was running for is
 * skipped. Not for what a job does (`app/scheduled-jobs.ts`), or how its pass is recorded (jobs.ts).
 */
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'

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
 * The longest one minute's claim may take before the next minute is waited for regardless: a pool
 * with no free connection waits without end, and the ticker must not wait with it.
 */
const TICK_BOUND_MS = 30 * SECOND_MS

/** What the ticker needs of the scheduled jobs: taking passes, and starting one taken. */
export interface Passes {
  /** The jobs among `names` whose pass this process may run now; the rest are another's or still run. */
  claim(names: string[]): Promise<string[]>
  /** Starts the pass of a job claimed. It ends by itself and records how it went. */
  start(name: string): void
}

/**
 * Starts each of `schedules` due in `at`'s minute that is claimed, and settles once they are
 * claimed, or after `boundMs` while the claim still hangs: it goes on by itself.
 */
export async function tick(
  passes: Passes,
  schedules: ReadonlyArray<readonly [string, string]>,
  at: Date,
  boundMs = TICK_BOUND_MS,
): Promise<void> {
  const claiming = (async () => {
    const names = schedules.filter(([, cron]) => due(cron, at)).map(([name]) => name)
    for (const name of await passes.claim(names)) passes.start(name)
  })().catch((error: unknown) => console.error('schedule: the passes were not claimed', error))
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(`schedule: the claim for ${at.toISOString()} still waits after ${boundMs} ms`)
      resolve()
    }, boundMs)
  })
  await Promise.race([claiming, bound])
  clearTimeout(timer)
}

/**
 * Starts each of `schedules` (job name and cron) as its minute comes, until the returned function
 * is called. Every expression is read once first, so one that can't be refuses at once. The minute
 * the worker starts in is taken at once too: a restart in a daily job's minute would otherwise
 * lose that day's run. Where another worker took it already, the claim drops this one.
 */
export function everyMinute(passes: Passes, schedules: ReadonlyArray<readonly [string, string]>): () => void {
  for (const [, cron] of schedules) due(cron, new Date(0))
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const next = () => {
    if (stopped) return
    const now = Date.now()
    const at = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS
    timer = setTimeout(
      () => {
        void tick(passes, schedules, new Date(at)).finally(next)
      },
      at + INTO_MINUTE_MS - now,
    )
    timer.unref()
  }
  void tick(passes, schedules, new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS)).finally(next)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
