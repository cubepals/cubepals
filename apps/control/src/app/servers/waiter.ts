import type { Db } from '@blockly/db'
import type { ServerStatus } from '../../domain/server/lifecycle.ts'
import type { EventBus } from '../ports/events.ts'
import { findServer } from './persistence.ts'

/**
 * Waits for a server to reach a status: woken by events, confirmed by reading the database, so a
 * missed notification costs at most one poll interval.
 */
export class ServerWaiter {
  readonly #db: Db
  readonly #events: EventBus
  readonly #waiting = new Map<string, Set<() => void>>()
  #unsubscribe: (() => Promise<void>) | null = null

  constructor(db: Db, events: EventBus) {
    this.#db = db
    this.#events = events
  }

  async start(): Promise<void> {
    this.#unsubscribe = await this.#events.subscribe((event) => {
      if (event.type !== 'server_changed') return
      for (const wake of this.#waiting.get(event.serverId) ?? []) wake()
    })
  }

  async stop(): Promise<void> {
    await this.#unsubscribe?.()
  }

  /** Resolves with the status once it is one of `targets`, or null when `timeoutMs` passes. */
  async waitFor(
    serverId: string,
    targets: readonly ServerStatus[],
    timeoutMs: number,
  ): Promise<ServerStatus | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const server = await findServer(this.#db, serverId)
      if (server === null) return null
      if (targets.includes(server.lifecycle.status)) return server.lifecycle.status
      await this.#nextChange(serverId, Math.min(1_000, deadline - Date.now()))
    }
    return null
  }

  #nextChange(serverId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.#waiting.get(serverId) ?? new Set()
      const done = () => {
        clearTimeout(timer)
        waiters.delete(done)
        if (waiters.size === 0) this.#waiting.delete(serverId)
        resolve()
      }
      const timer = setTimeout(done, Math.max(ms, 0))
      waiters.add(done)
      this.#waiting.set(serverId, waiters)
    })
  }
}
