/**
 * How a long check says what it is doing while it runs, for someone reading its log as it comes,
 * in a terminal or in GitHub Actions: plain lines only, never a spinner or a carriage return.
 *
 * While a step waits, `Progress` prints what it is waiting for, how long it has waited and what it
 * last saw (the server's state, its machine's), a line every so often and one whenever what it saw
 * changes. A step over before the first line is due prints nothing. `summaryTable` is the table a
 * check ends with: each step, whether it held, and how long it took.
 *
 * It formats and paces; it doesn't run steps or read any state itself: the check does both.
 */

/** A duration as a log reads it: `607.2s`. */
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** Time into a step, as a clock: `0:05`, `10:07`, `1:02:03`. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}:${s}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${s}`
}

/** One progress line, indented under the step's own `ok`/`FAIL` line as those are. */
export const progressLine = (atMs: number, text: string) => `  ..   ${clock(atMs).padStart(5)}  ${text}`

export interface ProgressOptions {
  write: (line: string) => void
  /** How long a step goes without a line before one is printed anyway. */
  everyMs?: number
  now?: () => number
}

/** What a running step is waiting for and what it has seen, printed at a readable pace. */
export class Progress {
  readonly #write: (line: string) => void
  readonly #every: number
  readonly #now: () => number
  #started: number | null = null
  #lastLine = 0
  #spoke = false
  #waitingFor = ''
  #seen = ''

  constructor(options: ProgressOptions) {
    this.#write = options.write
    this.#every = options.everyMs ?? 20_000
    this.#now = options.now ?? Date.now
  }

  /** A step starts: nothing is printed until it has gone on for a while. */
  begin(): void {
    this.#started = this.#now()
    this.#lastLine = this.#started
    this.#spoke = false
    this.#waitingFor = ''
    this.#seen = ''
  }

  /** The step is over; its own result line follows. */
  end(): void {
    this.#started = null
  }

  /** What the step waits for now, as `waitFor` names it: `went to sleep`, `settled`. */
  waiting(what: string): void {
    this.#waitingFor = what
  }

  /** What the step last saw. A change is printed at once, once the step has started printing. */
  saw(state: string): void {
    if (state === this.#seen) return
    this.#seen = state
    if (this.#started !== null && this.#spoke) this.#say(`now: ${state}`)
  }

  /** Called often; prints a line when the step has gone quiet for long enough. */
  tick(): void {
    if (this.#started === null || this.#now() - this.#lastLine < this.#every) return
    const waiting = this.#waitingFor === '' ? 'working' : `waiting for "${this.#waitingFor}"`
    this.#say(this.#seen === '' ? waiting : `${waiting}; ${this.#seen}`)
    this.#spoke = true
  }

  #say(text: string): void {
    const now = this.#now()
    this.#lastLine = now
    this.#write(progressLine(now - (this.#started ?? now), text))
  }
}

/** A step as it ended. */
export interface StepResult {
  name: string
  ok: boolean
  ms: number
}

/** The table a check ends with, one line per step and a total, aligned in plain text. */
export function summaryTable(steps: readonly StepResult[], totalMs: number): string[] {
  const width = Math.max('total'.length, ...steps.map((s) => s.name.length))
  const row = (name: string, result: string, took: string) =>
    `  ${name.padEnd(width)}  ${result.padEnd(6)}  ${took.padStart(8)}`
  const failed = steps.filter((s) => !s.ok).length
  const outcome = failed === 0 ? `${steps.length} ok` : `${steps.length - failed} ok, ${failed} failed`
  return [
    row('step', 'result', 'took'),
    ...steps.map((s) => row(s.name, s.ok ? 'ok' : 'FAIL', seconds(s.ms))),
    `${row('total', '', seconds(totalMs))}  ${outcome}`,
  ]
}
