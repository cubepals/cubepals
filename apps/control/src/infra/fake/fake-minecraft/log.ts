/**
 * Holds one fake server's console output, the last 2000 lines, and hands it to whoever reads or
 * follows it. It does not decide what a line says: the server and the image do
 * (`fake-minecraft.ts`, `image.ts`).
 */

import type { LogLine } from '../../../app/ports/platform.ts'

export class ServerLog {
  readonly #lines: LogLine[] = []
  readonly #listeners = new Set<(line: LogLine) => void>()

  /** A line of output; `bare` for a trace's continuation, which the game prints without a clock. */
  say(text: string, options: { bare?: boolean } = {}): void {
    const at = new Date()
    const clock = at.toISOString().slice(11, 19)
    const line = { at, text: text.startsWith('[init]') || options.bare ? text : `[${clock}] ${text}` }
    this.#lines.push(line)
    if (this.#lines.length > 2000) this.#lines.shift()
    for (const listener of this.#listeners) listener(line)
  }

  recent(limit: number): LogLine[] {
    return this.#lines.slice(-limit)
  }

  async *tail(signal: AbortSignal): AsyncIterable<LogLine> {
    const queue: LogLine[] = []
    let wake: (() => void) | null = null
    const listener = (line: LogLine) => {
      queue.push(line)
      wake?.()
    }
    this.#listeners.add(listener)
    const stop = () => wake?.()
    signal.addEventListener('abort', stop, { once: true })
    try {
      while (!signal.aborted) {
        const line = queue.shift()
        if (line !== undefined) {
          yield line
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = null
      }
    } finally {
      this.#listeners.delete(listener)
      signal.removeEventListener('abort', stop)
    }
  }
}
