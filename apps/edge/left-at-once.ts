// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A player whose game left a modded server as it joined, and what the edge tells them next. A
 * game whose mods differ from the server's gets a packet it can't read and hangs up on its own a
 * moment after joining, saying only what its code saw ("found 1 bytes extra whilst reading packet
 * custom_payload"); the server sees nothing but the player leaving. So when a game closes its own
 * connection that soon after it was handed to a server whose route lists the mods its players'
 * games match (`mods`), the edge keeps its address for that server a few minutes: the server list
 * there says the mods differ, and the next join is turned away once with which versions the
 * server runs and what to do in each launcher. The join after goes through as any other: the
 * edge can't see a game's mods, and never keeps a player out on what it only infers.
 *
 * Not for passing the connection on (`front.ts`), or for which mods a route lists (the control
 * plane's `players-mods.ts`).
 */
import type { EdgeRoute } from '@blockly/contracts/edge'
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { StatusRewrite } from './ping-notice.ts'
import type { SessionEnd } from './session-end.ts'

/** How soon a game's own hang-up counts as leaving as it joined, and how long it is remembered. */
export interface LeftTimes {
  /**
   * From the hand-off to the server: a login and a modded server's configuration take a few
   * seconds, and a game that can't read the server leaves the moment play begins.
   */
  atOnceMs: number
  /** How long the server list says so, and the next join waits to be told. */
  toldForMs: number
}

export const LEFT_TIMES: LeftTimes = { atOnceMs: 20 * SECOND_MS, toldForMs: 10 * MINUTE_MS }

/** The most addresses kept at once: the oldest goes first past it. */
const MOST_KEPT = 10_000

/** What the server list says, in two short lines. */
export const LEFT_STATUS = 'Your mods don’t match this server’s.\nJoin to see which to update.'

type Mods = NonNullable<EdgeRoute['mods']>

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A day as the game's screen says it: "16 Nov", with the year only when it isn't this one. */
function day(iso: string, now: Date): string | null {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const year = at.getUTCFullYear() === now.getUTCFullYear() ? '' : ` ${at.getUTCFullYear()}`
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}${year}`
}

/**
 * What the next join is told: that the game left as it joined, which mods the server runs at
 * which versions (those its last change moved first), and what to do in each launcher.
 */
export function leftWords(mods: Mods, now: Date): string {
  const changed = mods.changedAt === undefined ? null : day(mods.changedAt, now)
  const what = mods.pack ? 'pack' : 'mods'
  const differ = mods.pack ? 'Your pack doesn’t match this server’s.' : 'Your mods don’t match this server’s.'
  const runs = mods.list.map((mod) => `${mod.name} ${mod.version}`)
  if (mods.more !== undefined) runs.push(`and ${mods.more} more`)
  const steps = mods.pack
    ? ['Update the pack to that version in your launcher, then join again.']
    : [
        'Update yours to these versions, then join again:',
        'Modrinth App or CurseForge: open the profile, update its mods.',
        'Prism Launcher: Edit, Mods, Check for updates.',
        'Minecraft Launcher: put each at that version in your mods folder.',
      ]
  return [
    differ,
    'That’s why your game left as soon as it joined.',
    '',
    changed === null ? (mods.pack ? 'It plays:' : 'It runs:') : `Its ${what} changed on ${changed}. It runs:`,
    ...runs,
    '',
    ...steps,
  ].join('\n')
}

/** The addresses whose game left a server as it joined, and what each is still to be told. */
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
    if (!this.running(hostname)) return null
    return this.#until(hostname, ip) === null ? null : new StatusRewrite(LEFT_STATUS)
  }

  /** What a join from `ip` to `hostname` is told in place of going on, once; null for going on. */
  join(hostname: string, ip: string): string | null {
    if (this.#until(hostname, ip) === null) return null
    this.#kept.delete(`${ip} ${hostname}`)
    const mods = this.#modsOf(hostname)
    return mods === null ? null : leftWords(mods, new Date(this.#now()))
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
