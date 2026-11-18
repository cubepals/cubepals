// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How one server's console output reaches the people watching it: gathered into one message every
 * `BATCH_MS`, and at most `LINES_PER_SECOND` lines a second. A server that floods its console (a
 * mod logging in a loop) then costs the realtime process and each watching browser ten messages a
 * second, not one per line. Lines past the cap aren't sent; the next message says how many there
 * were, once a second at most. The server's own log keeps every line. Not for the earlier lines a
 * console opens with: those go to one watcher at once, as `consoleHistory`.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import type { ConsoleLine } from '../../app/console/feed.ts'

/** How long a tail gathers lines before sending them: short enough to read as live. */
export const BATCH_MS = 100
/** The most lines a tail sends in a second, more than anyone reads while a server boots. */
export const LINES_PER_SECOND = 1_000

/** One message to a console's watchers: the lines, and how many lines before them weren't sent. */
export interface ConsoleBatch {
  lines: ConsoleLine[]
  /** Lines left out since the last count, and when the last of them was printed; null when none were. */
  unshown: { count: number; at: Date } | null
}

/** The clock and timers a batcher runs on: the process's own unless a test gives its own. */
export interface BatchClock {
  now(): number
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}

const processClock: BatchClock = {
  now: () => performance.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/**
 * Gathers one tail's lines and hands `send` a batch at most every `BATCH_MS`. Counting is by the
 * second from the first line of each: within it, lines past `LINES_PER_SECOND` are counted, not
 * kept, and the count goes out once that second is over, with whatever lines come next. `close`
 * sends what is left, when the tail ends.
 */
export class ConsoleBatcher {
  readonly #send: (batch: ConsoleBatch) => void
  readonly #clock: BatchClock
  readonly #perSecond: number
  #pending: ConsoleLine[] = []
  #flushTimer: unknown = null
  /** When the current second began, and how many lines it has kept; null before its first line. */
  #second: { began: number; kept: number } | null = null
  #secondTimer: unknown = null
  /** Lines left out in the current second, not yet said. */
  #unshown: { count: number; at: Date } | null = null
  /** Lines left out in a second that is over, said with the next batch. */
  #owed: { count: number; at: Date } | null = null

  constructor(send: (batch: ConsoleBatch) => void, options: { clock?: BatchClock; perSecond?: number } = {}) {
    this.#send = send
    this.#clock = options.clock ?? processClock
    this.#perSecond = options.perSecond ?? LINES_PER_SECOND
  }

  add(line: ConsoleLine): void {
    const now = this.#clock.now()
    if (this.#second !== null && now - this.#second.began >= SECOND_MS) this.#endSecond()
    if (this.#second === null) {
      this.#second = { began: now, kept: 0 }
      this.#secondTimer = this.#clock.setTimer(() => this.#secondOver(), SECOND_MS)
    }
    if (this.#second.kept < this.#perSecond) {
      this.#second.kept++
      this.#pending.push(line)
    } else {
      this.#unshown = { count: (this.#unshown?.count ?? 0) + 1, at: line.at }
      return
    }
    this.#flushTimer ??= this.#clock.setTimer(() => this.#flush(), BATCH_MS)
  }

  /** Sends whatever is gathered and owed, and stops the timers: the tail has ended. */
  close(): void {
    if (this.#second !== null) this.#endSecond()
    this.#flush()
  }

  /** The second is over: what it left out is owed to the next batch, which goes out now. */
  #secondOver(): void {
    this.#secondTimer = null
    this.#endSecond()
    this.#flush()
  }

  #endSecond(): void {
    if (this.#secondTimer !== null) this.#clock.clearTimer(this.#secondTimer)
    this.#secondTimer = null
    this.#second = null
    if (this.#unshown === null) return
    this.#owed = {
      count: (this.#owed?.count ?? 0) + this.#unshown.count,
      at: this.#unshown.at,
    }
    this.#unshown = null
  }

  #flush(): void {
    if (this.#flushTimer !== null) this.#clock.clearTimer(this.#flushTimer)
    this.#flushTimer = null
    if (this.#pending.length === 0 && this.#owed === null) return
    const batch = { lines: this.#pending, unshown: this.#owed }
    this.#pending = []
    this.#owed = null
    this.#send(batch)
  }
}
