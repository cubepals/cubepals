// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { connect, type NatsConnection } from '@nats-io/transport-node'
import { z } from 'zod'
import type { LogLine, LogSource } from '../../app/ports/platform.ts'
import type { RuntimeHandle } from '../../app/ports/runtime.ts'
import { FlyApiError } from './client.ts'
import { decodeHandle } from './handle.ts'
import { type FlyCredentials, flyCredentials } from './token.ts'

/**
 * One machine's output. Live lines come from the org's NATS log stream, reachable only inside the
 * org's private network; history comes from the HTTP log API. Fly documents neither as stable, so
 * both are read the way flyctl reads them (logs/nats.go, fly-go resource_logs.go) and checked on
 * the way in. Only the machine's own output counts: Fly's proxy and runner lines are not the
 * server's. A tail never ends by itself, even when the machine is replaced; its reader stops it.
 */

const FLY_WEB_API = 'https://api.fly.io'

/** History widens only while the lines found fall short of the limit. */
const HISTORY_WINDOWS_MINUTES = [10, 120, 1440] as const
const MAX_HISTORY_PAGES = 20
const WORKLOAD = 'app'

// flyctl's natsLog (logs/entry.go): the fields read here.
const LiveEntry = z.object({
  event: z.object({ provider: z.string() }),
  message: z.string(),
  timestamp: z.string(),
})

// fly-go's getLogsResponse (resource_logs.go), as the API answered on 2026-09-19.
const HistoryPage = z.object({
  data: z.array(z.object({ attributes: z.unknown() })),
  meta: z.object({ next_token: z.string() }),
})
const HistoryEntry = z.object({
  timestamp: z.string(),
  message: z.string(),
  meta: z.object({ event: z.object({ provider: z.string() }) }),
})

export interface FlyLogSourceOptions {
  /** The org slug: the NATS user. */
  org: string
  /** The same token the Machines API takes. */
  token: string
  /** `nats://[fdaa::3]:4223` inside the org's network. */
  natsUrl: string
  apiUrl?: string
  fetch?: (url: URL, init: RequestInit) => Promise<Response>
  now?: () => number
}

export class FlyLogSource implements LogSource {
  readonly #org: string
  readonly #credentials: FlyCredentials
  readonly #natsUrl: string
  readonly #apiUrl: string
  readonly #fetch: (url: URL, init: RequestInit) => Promise<Response>
  readonly #now: () => number
  #nats: Promise<NatsConnection> | null = null

  constructor(options: FlyLogSourceOptions) {
    this.#org = options.org
    this.#credentials = flyCredentials(options.token)
    this.#natsUrl = options.natsUrl
    this.#apiUrl = options.apiUrl ?? FLY_WEB_API
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.#now = options.now ?? Date.now
  }

  async recent(handle: RuntimeHandle, limit: number): Promise<LogLine[]> {
    const { app, machineId } = decodeHandle(handle)
    if (machineId === null || limit <= 0) return []
    let lines: LogLine[] = []
    for (const minutes of HISTORY_WINDOWS_MINUTES) {
      lines = await this.#history(app, machineId, this.#now() - minutes * 60_000, limit)
      if (lines.length >= limit) break
    }
    return lines
  }

  async *tail(handle: RuntimeHandle, signal: AbortSignal): AsyncIterable<LogLine> {
    const { app, machineId } = decodeHandle(handle)
    if (machineId === null) return
    const scope = subject(app, machineId)
    const nats = await this.#connection()
    if (signal.aborted) return
    const subscription = nats.subscribe(scope)
    const stop = () => {
      if (!subscription.isClosed()) subscription.unsubscribe()
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      for await (const message of subscription) {
        const line = liveLine(message.string())
        if (line !== null) yield line
      }
    } finally {
      signal.removeEventListener('abort', stop)
      stop()
    }
  }

  /** For tests and shutdown; tails in progress end. */
  async close(): Promise<void> {
    const pending = this.#nats
    this.#nats = null
    const nats = await pending?.catch(() => null)
    await nats?.close()
  }

  /** One connection for every tail. It reconnects by itself, and a closed one is replaced. */
  #connection(): Promise<NatsConnection> {
    if (this.#nats !== null) return this.#nats
    const pending = connect({
      servers: this.#natsUrl,
      user: this.#org,
      pass: this.#credentials.natsPassword,
      name: 'blockly-logs',
      maxReconnectAttempts: -1,
    })
    const forget = () => {
      if (this.#nats === pending) this.#nats = null
    }
    pending.then((nats) => nats.closed().then(forget), forget)
    this.#nats = pending
    return pending
  }

  async #history(app: string, machineId: string, fromMs: number, limit: number): Promise<LogLine[]> {
    const kept: LogLine[] = []
    // The cursor is the last entry's time in nanoseconds (observed 2026-09-19), so a window can
    // start at any moment; an empty one starts a day back.
    let cursor = `${BigInt(Math.floor(fromMs)) * 1_000_000n}`
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const url = new URL(`/api/v1/apps/${encodeURIComponent(app)}/logs`, this.#apiUrl)
      url.searchParams.set('next_token', cursor)
      url.searchParams.set('instance', machineId)
      const response = await this.#fetch(url, { headers: { Authorization: this.#credentials.authorization } })
      if (!response.ok) throw new FlyApiError(response.status, `reading ${app}'s logs`, await response.text())
      const body = HistoryPage.parse(await response.json())
      for (const { attributes } of body.data) {
        const entry = HistoryEntry.safeParse(attributes)
        if (entry.success && entry.data.meta.event.provider === WORKLOAD)
          kept.push(lineOf(entry.data.timestamp, entry.data.message))
      }
      if (kept.length > limit) kept.splice(0, kept.length - limit)
      const next = body.meta.next_token
      if (body.data.length === 0 || next === '' || next === cursor) break
      cursor = next
    }
    return kept
  }
}

/**
 * `logs.<app>.<region>.<machine>`, any region. The names come from our own handles, but a `*` or
 * `>` in either would widen the subscription to other servers' output, so they are checked.
 */
export function subject(app: string, machineId: string): string {
  if (!/^[a-z0-9-]+$/.test(app) || !/^[a-z0-9]+$/.test(machineId))
    throw new Error(`Not a Fly app and machine: ${app} ${machineId}`)
  return `logs.${app}.*.${machineId}`
}

export function liveLine(payload: string): LogLine | null {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return null
  }
  const entry = LiveEntry.safeParse(value)
  if (!entry.success || entry.data.event.provider !== WORKLOAD) return null
  return lineOf(entry.data.timestamp, entry.data.message)
}

function lineOf(timestamp: string, message: string): LogLine {
  const at = new Date(timestamp)
  return { at: Number.isNaN(at.getTime()) ? new Date() : at, text: message.replace(/\r?\n$/, '') }
}
