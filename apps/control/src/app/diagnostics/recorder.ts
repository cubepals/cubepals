// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps what ran slow or failed, with whose it was (`context.ts`): a query past `queryMs` or one
 * Postgres refused, a tRPC procedure past `procedureMs` or answered with a 5xx, an HTTP request past
 * `requestMs` or answered with a 5xx. Nothing waits on it: records are held in memory and written
 * together every few seconds, so a request never waits on its own record.
 *
 * Bounded, because it runs hardest when the database is struggling: at most `perKey` records a
 * minute for one thing for one account, `perMinute` in all, and `held` waiting to be written; past
 * that a record is counted as dropped instead. Writing them is never recorded itself.
 *
 * Not for counts and percentiles across the platform, which the metrics keep (`docs/metrics.md`).
 */
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { currentWork, within } from './context.ts'
import { shapeOf } from './statement.ts'

export interface Thresholds {
  queryMs: number
  procedureMs: number
  requestMs: number
}

/** A query a person waits behind for a quarter second is slow; a page's call for a second. */
export const THRESHOLDS: Thresholds = { queryMs: 250, procedureMs: SECOND_MS, requestMs: 2 * SECOND_MS }

export type DiagnosticKind = 'query' | 'procedure' | 'request'

export interface DiagnosticRecord {
  at: Date
  kind: DiagnosticKind
  name: string
  ms: number
  error: string | null
  origin: string
  role: string
  accountId: string | null
  serverId: string | null
  requestId: string | null
  detail: Record<string, unknown>
}

/** Where records go: one call with every record held. */
export type DiagnosticsSink = (records: DiagnosticRecord[]) => Promise<void>

export interface RecorderOptions {
  thresholds?: Thresholds
  /** Records a minute for one thing (its kind and name) for one account, or for nobody. */
  perKey?: number
  /** Records a minute in all. */
  perMinute?: number
  /** Records held waiting to be written. */
  held?: number
  now?: () => Date
}

/** The most of an error's message a record keeps. */
const MESSAGE_CHARS = 300

/** A failure's SQLSTATE; `_OTHER` for one with none, such as a dropped connection. */
const sqlstateOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : '_OTHER'
}

/**
 * An error's first line, without the value Postgres quotes after a colon where a value was wrong
 * (`invalid input syntax for type uuid: "…"`); a constraint's or a column's name stays.
 */
const messageOf = (error: unknown): string =>
  ((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '')
    .replace(/: "(?:[^"\\]|\\.)*"/g, ': "?"')
    .slice(0, MESSAGE_CHARS)

export class DiagnosticsRecorder {
  readonly #role: string
  readonly #sink: DiagnosticsSink
  readonly #thresholds: Thresholds
  readonly #perKey: number
  readonly #perMinute: number
  readonly #held: number
  readonly #now: () => Date
  #records: DiagnosticRecord[] = []
  #minute = 0
  #inMinute = 0
  #byKey = new Map<string, number>()
  #writing: Promise<void> | null = null
  /** Records left out since the process started: past a limit, or lost to a failed write. */
  dropped = 0

  constructor(role: string, sink: DiagnosticsSink, options: RecorderOptions = {}) {
    this.#role = role
    this.#sink = sink
    this.#thresholds = options.thresholds ?? THRESHOLDS
    this.#perKey = options.perKey ?? 5
    this.#perMinute = options.perMinute ?? 300
    this.#held = options.held ?? 1000
    this.#now = options.now ?? (() => new Date())
  }

  /** A query ended: kept if it was slow or failed. `statement` is its text as it was sent. */
  query(statement: unknown, ms: number, error: unknown): void {
    if (error === null && ms < this.#thresholds.queryMs) return
    if (currentWork()?.quiet) return
    const shape = shapeOf(statement)
    if (shape === null) return
    this.#keep('query', shape.name, ms, error === null ? null : sqlstateOf(error), {
      operation: shape.operation,
      statement: shape.text,
      ...(error === null ? {} : { message: messageOf(error) }),
    })
  }

  /** A procedure or request was answered: kept if it was slow or answered with a 5xx. */
  served(kind: 'procedure' | 'request', name: string, status: number, ms: number): void {
    const limit = kind === 'procedure' ? this.#thresholds.procedureMs : this.#thresholds.requestMs
    if (status < 500 && ms < limit) return
    if (currentWork()?.quiet) return
    this.#keep(kind, name, ms, status >= 500 ? String(status) : null, { status })
  }

  #keep(
    kind: DiagnosticKind,
    name: string,
    ms: number,
    error: string | null,
    detail: Record<string, unknown>,
  ) {
    const work = currentWork()
    const at = this.#now()
    const minute = Math.floor(at.getTime() / MINUTE_MS)
    if (minute !== this.#minute) {
      this.#minute = minute
      this.#inMinute = 0
      this.#byKey.clear()
    }
    const key = `${kind} ${name} ${work?.accountId ?? ''}`
    const forKey = this.#byKey.get(key) ?? 0
    if (forKey >= this.#perKey || this.#inMinute >= this.#perMinute || this.#records.length >= this.#held) {
      this.dropped++
      return
    }
    this.#byKey.set(key, forKey + 1)
    this.#inMinute++
    this.#records.push({
      at,
      kind,
      name,
      ms: Math.round(ms * 10) / 10,
      error,
      origin: work?.origin ?? 'process',
      role: this.#role,
      accountId: work?.accountId ?? null,
      serverId: work?.serverId ?? null,
      requestId: work?.requestId ?? null,
      detail: work?.detail ? { ...detail, ...work.detail } : detail,
    })
  }

  /** Writes what is held, once at a time. A write that fails loses its records, counted as dropped. */
  flush(): Promise<void> {
    if (this.#writing) return this.#writing
    if (this.#records.length === 0) return Promise.resolve()
    const records = this.#records
    this.#records = []
    this.#writing = within({ quiet: true }, () => this.#sink(records))
      .catch((error: unknown) => {
        this.dropped += records.length
        console.error(`diagnostics: ${records.length} records could not be written: ${messageOf(error)}`)
      })
      .finally(() => {
        this.#writing = null
      })
    return this.#writing
  }

  /** Writes every `everyMs` until stopped; stopping writes what is left. */
  start(everyMs = 2 * SECOND_MS): () => Promise<void> {
    const timer = setInterval(() => void this.flush(), everyMs)
    timer.unref()
    return async () => {
      clearInterval(timer)
      await this.#writing
      await this.flush()
    }
  }
}
