// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sleeping servers a server-list ping has asked the control plane to wake early, and what it
 * answered. Each server is asked at most once a while however often it is pinged, and pings
 * meanwhile hear that answer. Not for what a ping is told (`agent.ts`), or for whether a server is
 * woken, which is the control plane's to decide.
 */
export class PingWakes {
  readonly #ask: (hostname: string) => Promise<boolean>
  readonly #everyMs: number
  readonly #now: () => number
  readonly #asks = new Map<string, { at: number; waking: Promise<boolean>; woke: boolean }>()

  /** `ask` asks the control plane, and says whether the server is waking; a failed ask says it isn't. */
  constructor(ask: (hostname: string) => Promise<boolean>, everyMs: number, now: () => number = Date.now) {
    this.#ask = ask
    this.#everyMs = everyMs
    this.#now = now
  }

  /** Asks for `hostname`, or hears the ask already made within the while. */
  ask(hostname: string): Promise<boolean> {
    const now = this.#now()
    const last = this.#asks.get(hostname)
    if (last !== undefined && now - last.at < this.#everyMs) return last.waking
    for (const [name, asked] of this.#asks) if (now - asked.at >= this.#everyMs) this.#asks.delete(name)
    const asked = { at: now, woke: false, waking: Promise.resolve(false) }
    asked.waking = this.#ask(hostname)
      .catch(() => false)
      .then((waking) => {
        asked.woke = waking
        return waking
      })
    this.#asks.set(hostname, asked)
    return asked.waking
  }

  /** Whether an ask within the while was answered that `hostname` is waking. */
  waking(hostname: string): boolean {
    const last = this.#asks.get(hostname)
    return last?.woke === true && this.#now() - last.at < this.#everyMs
  }
}
