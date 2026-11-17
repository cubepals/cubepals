// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A player whose game may have left a modded server for its mods, and what the edge says of it. A
 * game whose mods differ from the server's gets a packet it can't read and hangs up on its own a
 * moment after joining, saying only what its code saw ("found 1 bytes extra whilst reading packet
 * custom_payload"); the server sees nothing but the player leaving. So when a game closes its own
 * connection that soon after it was handed to a server whose route lists the mods its players'
 * games match (`mods`), the edge keeps its address for that server a few minutes, and the server
 * list there says the mods may not match and which versions the server runs. It is said as a
 * possibility, and no join is ever turned away for it: the edge can't see a game's mods, a game
 * can leave that soon for other reasons (a crash, a player who changed their mind), and an address
 * can be a whole household's.
 *
 * Not for passing the connection on (`front.ts`), or for which mods a route lists (the control
 * plane's `players-mods.ts`).
 */
import type { EdgeRoute } from '@blockly/contracts/edge'
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { motdLayout } from '../../packages/contracts/src/motd-layout.ts'
import { StatusRewrite } from './ping-notice.ts'
import type { SessionEnd } from './session-end.ts'

/** How soon a game's own hang-up counts as leaving as it joined, and how long it is remembered. */
export interface LeftTimes {
  /**
   * From the hand-off to the server: a login and a modded server's configuration take a few
   * seconds, and a game that can't read the server leaves the moment play begins.
   */
  atOnceMs: number
  /** How long the server list says so. */
  toldForMs: number
}

export const LEFT_TIMES: LeftTimes = { atOnceMs: 20 * SECOND_MS, toldForMs: 10 * MINUTE_MS }

/** The most addresses kept at once: the oldest goes first past it. */
const MOST_KEPT = 10_000

type Mods = NonNullable<EdgeRoute['mods']>

/** Names as a sentence lists them: "A, B and C", or "A, B and 6 more". */
function listed(names: readonly string[], more: number): string {
  if (more > 0) return `${names.join(', ')} and ${more} more`
  return names.length === 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * What the server list says to an address whose game left as it joined: that its mods may not
 * match, then what the server runs at which versions, those its last change moved first, as many
 * as the list's two lines hold, and how many more.
 */
export function leftStatus(mods: Mods): string {
  const opening = mods.pack ? 'Your pack may not match. It plays' : 'Your mods may not match. It runs'
  const named = mods.list.map((mod) => `${mod.name} ${mod.version}`)
  const all = named.length + (mods.more ?? 0)
  for (let shown = named.length; shown > 0; shown--) {
    const status = `${opening} ${listed(named.slice(0, shown), all - shown)}.`
    if (motdLayout(status).cutCount === 0) return status
  }
  if (mods.pack) return 'Your pack may not match this server’s.'
  return `Your mods may not match. It runs ${all === 1 ? 'one mod' : `${all} mods`}.`
}

/** The addresses whose game left a server as it joined, and until when each one's server list says so. */
export class LeftAtOnce {
  readonly #route: (hostname: string) => EdgeRoute | undefined
  readonly #times: LeftTimes
  readonly #now: () => number
  /** Until when each address at each server is told, oldest first. */
  readonly #kept = new Map<string, number>()

  constructor(
    route: (hostname: string) => EdgeRoute | undefined,
    times: LeftTimes = LEFT_TIMES,
    now: () => number = Date.now,
  ) {
    this.#route = route
    this.#times = times
    this.#now = now
  }

  /** How many addresses it keeps now: what it holds in memory. */
  held(): number {
    return this.#kept.size
  }

  /**
   * A join from `ip` to `hostname` closed as `end` says, `handedAt` (ISO) being when it was handed
   * to the server: kept if the game hung up by itself that soon, at a server whose players' games
   * match its mods. A join never handed over reached no server's mods.
   */
  left(hostname: string, ip: string, handedAt: string | undefined, end: SessionEnd): void {
    if (handedAt === undefined || end.closedFirst !== 'player' || end.how !== 'closed') return
    const now = this.#now()
    const after = now - new Date(handedAt).getTime()
    if (!(after >= 0 && after <= this.#times.atOnceMs)) return
    if (this.#modsOf(hostname) === null) return
    const key = `${ip} ${hostname}`
    this.#kept.delete(key)
    this.#kept.set(key, now + this.#times.toldForMs)
    for (const [kept, until] of this.#kept)
      if (this.#kept.size > MOST_KEPT || until <= now) this.#kept.delete(kept)
      else break
  }

  /** Whether `hostname`'s server runs, so a join let through now is handed to it at once, not held. */
  running(hostname: string): boolean {
    const route = this.#route(hostname)
    return route !== undefined && route.state === undefined
  }

  /** What a ping from `ip` to `hostname` goes back through, for a running server; null for its own answer. */
  status(hostname: string, ip: string): StatusRewrite | null {
    if (!this.running(hostname) || this.#until(hostname, ip) === null) return null
    const mods = this.#modsOf(hostname)
    return mods === null ? null : new StatusRewrite(leftStatus(mods))
  }

  /** Until when `ip` is told at `hostname`; null when it isn't, any more, or the server lists no mods now. */
  #until(hostname: string, ip: string): number | null {
    const key = `${ip} ${hostname}`
    const until = this.#kept.get(key)
    if (until === undefined) return null
    if (until <= this.#now() || this.#modsOf(hostname) === null) {
      this.#kept.delete(key)
      return null
    }
    return until
  }

  #modsOf(hostname: string): Mods | null {
    const mods = this.#route(hostname)?.mods
    return mods === undefined || mods.list.length === 0 ? null : mods
  }
}
