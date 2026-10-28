// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server list's line for a sleeping server on its way up: that it is waking, and about how long
 * is left of a wake its way, by the median the control plane measured (`EdgeRoute.wakeSeconds`),
 * counted from when this edge first saw it waking. Without a measurement, or once the wait runs
 * past it, the line says only that it is waking: never a time nobody measured, never zero.
 *
 * Not for whether a server is waking (the routes and ping wakes say), or for the line's place in
 * the list (`asleep.ts`).
 */
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'

/** What a waking server's line starts with. */
export const WAKING = 'Waking your world'

/** A wake seen longer ago than this is a new one: its route never said it had stopped waking. */
const FORGOTTEN_MS = 15 * MINUTE_MS

/** About how long `seconds` is, as the server page's countdown rounds it: by fives past ten. */
function about(seconds: number): string {
  if (seconds <= 10) return `about ${seconds} second${seconds === 1 ? '' : 's'}`
  if (seconds < 120) return `about ${Math.ceil(seconds / 5) * 5} seconds`
  return `about ${Math.round(seconds / 60)} minutes`
}

/** The line for a wake that takes `seconds` in all, `elapsedMs` in. */
export function wakingNotice(seconds: number | undefined, elapsedMs: number): string {
  if (seconds === undefined) return WAKING
  const left = Math.ceil(seconds - elapsedMs / SECOND_MS)
  return left < 1 ? WAKING : `${WAKING} · ${about(left)}`
}

/** When each hostname was first seen waking, by this edge, so each ping counts down from there. */
export class WakingLine {
  readonly #since = new Map<string, number>()
  readonly #fixed: string
  readonly #now: () => number

  /** `fixed`: an operator's own words, said instead of the countdown; empty for the countdown. */
  constructor(fixed: string, now: () => number = Date.now) {
    this.#fixed = fixed
    this.#now = now
  }

  /** The line for `hostname`'s server, or null while it isn't waking, which forgets when it began. */
  of(hostname: string, waking: boolean, seconds: number | undefined): string | null {
    if (!waking) {
      this.#since.delete(hostname)
      return null
    }
    const now = this.#now()
    const seen = this.#since.get(hostname)
    const since = seen === undefined || now - seen > FORGOTTEN_MS ? now : seen
    this.#since.set(hostname, since)
    return this.#fixed === '' ? wakingNotice(seconds, now - since) : this.#fixed
  }

  /**
   * Forgets each wake whose server is waking no more by its route, nor by a ping's ask
   * (`stillWaking`): one that ran since counts its next wake down afresh, however soon it comes.
   */
  keep(
    routes: readonly { hostname: string; waking?: true }[],
    stillWaking: (hostname: string) => boolean,
  ): void {
    const waking = new Set(routes.filter((r) => r.waking === true).map((r) => r.hostname))
    for (const hostname of this.#since.keys())
      if (!waking.has(hostname) && !stillWaking(hostname)) this.#since.delete(hostname)
  }
}

/** The agent's: an operator's own words in `WAKING_MOTD` instead of the countdown, where set. */
export const wakingLine = new WakingLine(process.env.WAKING_MOTD ?? '')
