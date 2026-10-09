import type { Db } from '@blockly/db'
import { type ConsoleLevel, classifyLine } from '../../minecraft/logs.ts'
import { isAdmin } from '../accounts/persistence.ts'
import type { LogSource } from '../ports/platform.ts'
import { findServer, loadRuntime } from '../servers/persistence.ts'

export interface ConsoleLine {
  at: Date
  text: string
  level: ConsoleLevel
}

/** A running server's output as the console shows it, for the people allowed to watch it. */
export class ConsoleFeed {
  readonly #db: Db
  readonly #logs: LogSource
  readonly #providers: readonly string[]

  /** `providers` are the runtimes whose handles `logs` reads. */
  constructor(db: Db, logs: LogSource, providers: readonly string[]) {
    this.#db = db
    this.#logs = logs
    this.#providers = providers
  }

  /** A server's console is its owner's to watch, and any platform admin's (§13). */
  async canWatch(userId: string, serverId: string): Promise<boolean> {
    const server = await findServer(this.#db, serverId)
    if (server === null) return false
    return server.ownerId === userId || (await isAdmin(this.#db, userId))
  }

  /**
   * The last lines a server printed, as the console shows them, for someone who just opened it
   * (§13). Nothing when the server has no workload, or the provider has lost its output.
   */
  async recent(serverId: string, limit: number): Promise<ConsoleLine[]> {
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
