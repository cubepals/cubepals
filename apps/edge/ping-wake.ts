// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sleeping servers a server-list ping has asked the control plane to wake early, and what it
 * answered. The control plane answers by where the ping came from, so each server is asked at most
 * once a while from each network however often it is pinged, and pings meanwhile hear that answer:
 * a stranger told no never stands in for a player of the server's own. Not for what a ping is told
 * (`agent.ts`), or for whether a server is woken, which is the control plane's to decide.
 */
import { addressKey } from './limits.ts'

export class PingWakes {
  readonly #ask: (hostname: string, address: string | null) => Promise<boolean>
  readonly #everyMs: number
  readonly #now: () => number
  /** By hostname and network. */
  readonly #asks = new Map<string, { at: number; waking: Promise<boolean> }>()
  /** When an ask was last answered that each hostname is waking. */
  readonly #woke = new Map<string, number>()

  /**
   * `ask` asks the control plane for a ping from `address` (null when the edge doesn't know it), and
   * says whether the server is waking; a failed ask says it isn't.
   */
  constructor(
    ask: (hostname: string, address: string | null) => Promise<boolean>,
    everyMs: number,
    now: () => number = Date.now,
  ) {
    this.#ask = ask
    this.#everyMs = everyMs
    this.#now = now
  }

  /** Asks for `hostname` pinged from `address`, or hears the ask already made within the while. */
  ask(hostname: string, address: string | null): Promise<boolean> {
    const now = this.#now()
    const key = `${hostname} ${address === null ? '' : addressKey(address)}`
    const last = this.#asks.get(key)
    if (last !== undefined && now - last.at < this.#everyMs) return last.waking
    for (const [name, asked] of this.#asks) if (now - asked.at >= this.#everyMs) this.#asks.delete(name)
    for (const [name, at] of this.#woke) if (now - at >= this.#everyMs) this.#woke.delete(name)
    const waking = this.#ask(hostname, address)
      .catch(() => false)
      .then((woke) => {
        if (woke) this.#woke.set(hostname, now)
        return woke
      })
    this.#asks.set(key, { at: now, waking })
    return waking
  }

  /** Whether an ask within the while, from anywhere, was answered that `hostname` is waking. */
  waking(hostname: string): boolean {
    const at = this.#woke.get(hostname)
    return at !== undefined && this.#now() - at < this.#everyMs
  }
}
