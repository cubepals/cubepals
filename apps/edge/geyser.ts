// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geyser as a child of the edge agent: started, its output in the agent's own logs, and started
 * again when it exits, with a wait that grows while it keeps failing. The agent's other child,
 * mc-router, is different on purpose: with it gone the edge is useless, so the agent exits; with
 * Geyser gone, Java players are fine, so only Bedrock waits. Not for what Geyser is told
 * (`geyser-config.ts`) or where it listens (`bedrock.ts`).
 */

import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'

export interface Supervision {
  command: string[]
  cwd: string
  /** The only environment the child gets: nothing of the agent's own (its secrets) unless named here. */
  env: Record<string, string>
  /** Put in front of each line the child writes, so the agent's logs say whose it is. */
  prefix: string
  /** The wait before the first start again; it doubles each time up to `longest`. */
  firstWaitMs?: number
  longestWaitMs?: number
  /** How long it must have run for the next wait to be the first again. */
  steadyMs?: number
}

export type GeyserState = 'starting' | 'running' | 'waiting'

export class Supervised {
  readonly #options: Supervision
  #state: GeyserState = 'starting'
  #restarts = 0
  #stopped = false
  #child: ReturnType<typeof Bun.spawn> | null = null

  constructor(options: Supervision) {
    this.#options = options
  }

  get state(): GeyserState {
    return this.#state
  }

  /** How many times it has been started again. */
  get restarts(): number {
    return this.#restarts
  }

  /** Runs until `stop`. */
  async run(): Promise<void> {
    const { command, cwd, prefix } = this.#options
    const first = this.#options.firstWaitMs ?? SECOND_MS
    const longest = this.#options.longestWaitMs ?? 30 * SECOND_MS
    const steady = this.#options.steadyMs ?? MINUTE_MS
    let wait = first
    while (!this.#stopped) {
      const began = Date.now()
      this.#state = 'running'
      this.#child = Bun.spawn(command, { cwd, env: this.#options.env, stdout: 'pipe', stderr: 'pipe' })
      const [code] = await Promise.all([
        this.#child.exited,
        lines(this.#child.stdout as ReadableStream<Uint8Array>, prefix),
        lines(this.#child.stderr as ReadableStream<Uint8Array>, prefix),
      ])
      if (this.#stopped) return
      this.#state = 'waiting'
      wait = Date.now() - began >= steady ? first : Math.min(wait * 2, longest)
      console.error(`${prefix} exited with ${code}; starting again in ${Math.round(wait / SECOND_MS)} s`)
      await Bun.sleep(wait)
      this.#restarts++
    }
  }

  stop(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.#stopped = true
    this.#child?.kill(signal)
  }
}

/** Writes each line of `stream` to the agent's stderr behind `prefix`. */
async function lines(stream: ReadableStream<Uint8Array>, prefix: string): Promise<void> {
  const decoder = new TextDecoder()
  let rest = ''
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true })
    const parts = rest.split('\n')
    rest = parts.pop() ?? ''
    for (const line of parts) console.error(`${prefix} ${Bun.stripANSI(line)}`)
  }
  if (rest !== '') console.error(`${prefix} ${rest}`)
}
