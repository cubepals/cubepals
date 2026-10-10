// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { RuntimeFull } from '../../app/ports/runtime.ts'
import { BoatApiError, type BoatClient } from './client.ts'

/**
 * Boat counts every create, fork and resume as a machine start, against limits per minute, hour
 * and day that its plans set (docs.boat.dev/pricing). A server that sleeps when idle spends one
 * each time a join wakes it, so starts are the resource here, and this is where they are counted
 * and kept within the plan. Boat's own `/limits` is the count: it is fleet-wide, and it survives
 * this process, so a bigger plan needs nothing changed here.
 */

export type StartKind = 'create' | 'resume' | 'fork'
/**
 * Why a start was made. `snapshot`, `export` and `forget` do work on a server that is asleep and
 * nobody is waiting on; the rest bring up a server someone asked for.
 */
export type StartReason = 'provision' | 'start' | 'apply' | 'restore' | 'snapshot' | 'export' | 'forget'
const UPKEEP: ReadonlySet<StartReason> = new Set(['snapshot', 'export', 'forget'])

type Window = 'minute' | 'hour' | 'day'
const WINDOWS: readonly Window[] = ['minute', 'hour', 'day']

export interface StartWindows {
  canStart: boolean
  windows: Record<Window, { limit: number; used: number; remaining: number }>
}

export interface BoatStartsOptions {
  /** A share of the day's starts upkeep leaves to starts someone asked for; 0.1 by default. */
  reserve?: number
  /** How long a read of the limits is trusted, when no start was made since. */
  cacheMs?: number
  /** Waits; tests pass one that doesn't. */
  pause?: (ms: number) => Promise<void>
  log?: (line: string) => void
  now?: () => Date
}

/** At or past this share of any window, every start is logged as a warning. */
const WARN_AT = 0.8
/** A minute's window passes; a start refused for it waits this long at most before giving up. */
const MINUTE_WAIT_MS = 75_000

export class BoatStarts {
  readonly #client: BoatClient
  readonly #reserve: number
  readonly #cacheMs: number
  readonly #pause: (ms: number) => Promise<void>
  readonly #log: (line: string) => void
  readonly #now: () => Date
  #read: { at: number; windows: StartWindows } | null = null
  /** Starts this process made, by server and UTC day, for the log line. */
  readonly #byServer = new Map<string, number>()

  constructor(client: BoatClient, options: BoatStartsOptions = {}) {
    this.#client = client
    this.#reserve = options.reserve ?? 0.1
    this.#cacheMs = options.cacheMs ?? 5_000
    this.#pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#log = options.log ?? ((line) => console.warn(line))
    this.#now = options.now ?? (() => new Date())
  }

  /** The start windows as Boat counts them now. */
  async windows(fresh = false): Promise<StartWindows> {
    const now = this.#now().getTime()
    if (!fresh && this.#read !== null && now - this.#read.at < this.#cacheMs) return this.#read.windows
    const { data, error, response } = await this.#client.GET('/limits')
    if (!response.ok || data === undefined) throw new BoatApiError(response.status, 'reading limits', error)
    const body = data as unknown as {
      canStart?: boolean
      starts?: Partial<Record<Window, { limit?: number; used?: number; remaining?: number }>>
    }
    const window = (name: Window) => {
      const read = body.starts?.[name]
      const limit = read?.limit ?? Number.POSITIVE_INFINITY
      const used = read?.used ?? 0
      return { limit, used, remaining: read?.remaining ?? limit - used }
    }
    const windows: StartWindows = {
      canStart: body.canStart !== false,
      windows: { minute: window('minute'), hour: window('hour'), day: window('day') },
    }
    this.#read = { at: now, windows }
    return windows
  }

  /**
   * Makes one start through `start`, which calls Boat, when the plan has room for it. A plan
   * without room throws RuntimeFull before Boat is asked; a minute's window Boat refuses is waited
   * out, since whoever asked is waiting anyway; an hour's or a day's is not.
   */
  async make<T>(kind: StartKind, reason: StartReason, server: string, start: () => Promise<T>): Promise<T> {
    const deadline = this.#now().getTime() + MINUTE_WAIT_MS
    for (let attempt = 0; ; attempt++) {
      const full = this.#fullFor(reason, await this.windows(attempt > 0))
      if (full !== null && !(full === 'minute' && this.#now().getTime() < deadline))
        throw new RuntimeFull(
          'boat',
          `the plan's starts for this ${full} are used up (${reason} of ${server})`,
        )
      if (full === null) {
        try {
          const made = await start()
          this.#made(kind, reason, server)
          return made
        } catch (error) {
          if (!(error instanceof BoatApiError && error.status === 429)) throw error
          // The plan's sandboxes running at once are all running: waiting doesn't free one.
          if (error.code === 'limit_reached' || error.code === 'member_limit_reached')
            throw new RuntimeFull('boat', error.message)
          this.#read = null
          if (this.#now().getTime() >= deadline) throw new RuntimeFull('boat', error.message)
        }
      }
      await this.#pause(Math.min(15_000, 2_000 * 2 ** attempt) + Math.random() * 500)
    }
  }

  /**
   * Whether the plan has starts to spare beyond the share kept for wakes: room for a new server,
   * which will need starts of its own every time it wakes (docs/runtimes.md, placement).
   */
  async headroom(): Promise<boolean> {
    return this.#fullFor('snapshot', await this.windows()) === null
  }

  /** The window with no room left for this start, or null when there is room. */
  #fullFor(reason: StartReason, read: StartWindows): Window | 'plan' | null {
    if (!read.canStart) return 'plan'
    for (const name of WINDOWS) if (read.windows[name].remaining <= 0) return name
    // Upkeep leaves the end of the day to wakes.
    const day = read.windows.day
    if (UPKEEP.has(reason) && Number.isFinite(day.limit) && day.remaining <= day.limit * this.#reserve)
      return 'day'
    return null
  }

  #made(kind: StartKind, reason: StartReason, server: string): void {
    const key = `${this.#now().toISOString().slice(0, 10)} ${server}`
    const today = (this.#byServer.get(key) ?? 0) + 1
    this.#byServer.set(key, today)
    if (this.#byServer.size > 10_000) this.#byServer.clear()
    const read = this.#read?.windows
    const counts = WINDOWS.map((name) => {
      const window = read?.windows[name]
      return window ? `${name}=${window.used + 1}/${window.limit}` : `${name}=?`
    }).join(' ')
    const busy = WINDOWS.some((name) => {
      const window = read?.windows[name]
      return window !== undefined && (window.used + 1) / window.limit >= WARN_AT
    })
    this.#log(
      `boat start: kind=${kind} reason=${reason} server=${server} today=${today} ${counts}${busy ? ' (near the plan limit)' : ''}`,
    )
    // The next start reads Boat again, rather than a count this one made stale.
    this.#read = null
  }
}
