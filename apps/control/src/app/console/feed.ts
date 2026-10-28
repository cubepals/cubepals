// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { SECOND_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import { type ConsoleLevel, classifyLine } from '../../minecraft/logs.ts'
import { isAdmin, stillSignedIn } from '../accounts/persistence.ts'
import type { Limits } from '../ports/limits.ts'
import type { LogSource } from '../ports/platform.ts'
import type { TicketHolder } from '../ports/tickets.ts'
import { findServer, loadRuntime } from '../servers/persistence.ts'
import { tuning } from '../tuning.ts'

export interface ConsoleLine {
  at: Date
  text: string
  level: ConsoleLevel
}

/**
 * How long one read of a server's earlier lines is still handed to whoever else opens its console,
 * after it is done. While it is being read, everyone who asks waits for the same read.
 */
const RECENT_SHARED_MS = 2 * SECOND_MS

/** A running server's output as the console shows it, for the people allowed to watch it. */
export class ConsoleFeed {
  readonly #db: Db
  readonly #logs: LogSource
  readonly #providers: readonly string[]
  readonly #limits: Limits
  /** Reads of earlier lines by server and count, with when each stops being handed out. */
  readonly #recent = new Map<string, { lines: Promise<ConsoleLine[]>; until: number }>()

  /** `providers` are the runtimes whose handles `logs` reads; `limits` counts consoles opened. */
  constructor(db: Db, logs: LogSource, providers: readonly string[], limits: Limits) {
    this.#db = db
    this.#logs = logs
    this.#providers = providers
    this.#limits = limits
  }

  /**
   * Whether the sign-in a realtime session was opened from still stands, on an account in good
   * standing. A session whose sign-in has ended watches nothing more.
   */
  stillSignedIn({ userId, sessionId }: TicketHolder): Promise<boolean> {
    return stillSignedIn(this.#db, userId, sessionId)
  }

  /** Whether `userId` may open one more console this minute (`AbuseLimits.consoleWatchesPerMinute`). */
  mayOpen(userId: string): Promise<boolean> {
    return this.#limits.allow(`console-watch:${userId}`, tuning().abuse.consoleWatchesPerMinute)
  }

  /** A server's console is its owner's to watch, and any platform admin's (§13). */
  async canWatch(userId: string, serverId: string): Promise<boolean> {
    const server = await findServer(this.#db, serverId)
    if (server === null) return false
    return server.ownerId === userId || (await isAdmin(this.#db, userId))
  }

  /**
   * The last lines a server printed, as the console shows them, for someone who just opened it
   * (§13). Nothing when the server has no workload, or the provider has lost its output. People
   * opening the same console at once share one read of the provider's logs.
   */
  recent(serverId: string, limit: number): Promise<ConsoleLine[]> {
    const key = `${serverId}:${limit}`
    const now = Date.now()
    for (const [held, read] of this.#recent) if (read.until <= now) this.#recent.delete(held)
    const shared = this.#recent.get(key)
    if (shared !== undefined) return shared.lines
    const read = { lines: this.#readRecent(serverId, limit), until: Number.POSITIVE_INFINITY }
    this.#recent.set(key, read)
    read.lines.then(
      () => {
        read.until = Date.now() + RECENT_SHARED_MS
      },
      () => {
        if (this.#recent.get(key) === read) this.#recent.delete(key)
      },
    )
    return read.lines
  }

  async #readRecent(serverId: string, limit: number): Promise<ConsoleLine[]> {
    const { handle } = await loadRuntime(this.#db, serverId, this.#providers)
    if (handle === null) return []
    const lines = await this.#logs.recent(handle, limit).catch(() => [])
    return lines.flatMap((line) => {
      const shown = classifyLine(line.text)
      return shown === null ? [] : [{ at: line.at, ...shown }]
    })
  }

  async *tail(serverId: string, signal: AbortSignal): AsyncIterable<ConsoleLine> {
    const { handle } = await loadRuntime(this.#db, serverId, this.#providers)
    if (handle === null) return
    for await (const line of this.#logs.tail(handle, signal)) {
      const shown = classifyLine(line.text)
      if (shown !== null) yield { at: line.at, ...shown }
    }
  }
}
