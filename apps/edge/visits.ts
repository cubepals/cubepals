// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One visit per connection to the front door, reported to the control plane in halves sharing a
 * `joinId` (`VisitReport`): `open` once the join is handed to its server, or turned away, and
 * `close` a moment after it ends, once the edge has seen whether the player pinged the server
 * again. A server-list ping that no join from the same address follows is reported as a `look`,
 * so many at the most. Addresses are held only in memory, and only for minutes.
 *
 * Not for deciding anything about a connection: the gate (`limits.ts`) and the routes do that.
 */
import { HOUR_MS, MINUTE_MS } from '../../packages/contracts/src/durations.ts'
import type { VisitReport } from '../../packages/contracts/src/join-records.ts'
import { unmapped } from '../../packages/contracts/src/proxy-header.ts'

/** A connection's `ip:port`, as visits are found by: an IPv6 address in brackets. */
export function sourceKey(address: string, port: number): string {
  const ip = unmapped(address).toLowerCase()
  if (!ip.includes(':')) return `${ip}:${port}`
  // A PROXY header's IPv6 address comes uncompressed; a socket's, compressed: the same either way.
  return `${new URL(`http://[${ip}]/`).hostname}:${port}`
}

const ipOf = (source: string) =>
  source.startsWith('[') ? source.slice(0, source.indexOf(']') + 1) : source.slice(0, source.lastIndexOf(':'))

/** What a visit has gathered so far: the report it becomes, less the phase. */
export type Visit = Omit<VisitReport, 'phase'> & { opened: boolean }

/** How long the edge keeps watching, and how many looks it reports. */
export interface VisitTimes {
  /** How long a ping is remembered for a join, and a closed visit waits for a ping after it. */
  lingerMs: number
  /** One look per address a player pinged at most this often. */
  lookEveryMs: number
  /** At most this many looks an hour per server address. */
  looksPerHour: number
}

export const VISIT_TIMES: VisitTimes = {
  lingerMs: 2 * MINUTE_MS,
  lookEveryMs: 10 * MINUTE_MS,
  looksPerHour: 60,
}

/** A ping no join followed yet: when, from where, and whether a look will be sent for it. */
interface Ping {
  at: Date
  source: string
  joined: boolean
}

export class Visits {
  readonly #send: (report: VisitReport) => void
  readonly #edge: { edgeId: string; region: string }
  readonly #times: VisitTimes
  readonly #now: () => Date
  /** Open and lingering visits, by source. */
  readonly #visits = new Map<string, Visit>()
  /** The last ping from each client address to each server address. */
  readonly #pings = new Map<string, Ping>()
  /** When a look was last sent for each client and server address. */
  readonly #looked = new Map<string, number>()
  /**
   * Where mc-router saw a connection come from, by the visit it is: the front door's own end of
   * the connection it made, for a server sent no PROXY header, which mc-router then can't read.
   */
  readonly #aliases = new Map<string, string>()
  /** Looks sent per server address this hour, and those left unsent. */
  readonly #looks = new Map<string, { since: number; sent: number; more: number }>()

  constructor(
    send: (report: VisitReport) => void,
    edge: { edgeId: string; region: string },
    times: VisitTimes = VISIT_TIMES,
    now: () => Date = () => new Date(),
  ) {
    this.#send = send
    this.#edge = edge
    this.#times = times
    this.#now = now
  }

  /** How many visits, pings and addresses' hours of looks it holds now: what it keeps in memory. */
  held(): { visits: number; pings: number; looks: number } {
    return { visits: this.#visits.size, pings: this.#pings.size, looks: this.#looks.size }
  }

  /** A join arrived from `source` for `address`: its visit begins. */
  arrived(source: string, handshake: { address: string; protocol: number }): Visit {
    const ping = this.#pings.get(`${ipOf(source)} ${handshake.address}`)
    if (ping !== undefined) ping.joined = true
    const visit: Visit = {
      joinId: Bun.randomUUIDv7(),
      ...this.#edge,
      address: handshake.address,
      source,
      protocol: handshake.protocol,
      connectedAt: this.#now().toISOString(),
      ...(ping === undefined ? {} : { pingedAt: ping.at.toISOString() }),
      opened: false,
    }
    this.#visits.set(source, visit)
    return visit
  }

  /** A server-list ping from `source` for `address`. */
  pinged(source: string, address: string): void {
    const key = `${ipOf(source)} ${address}`
    const at = this.#now()
    const ping: Ping = { at, source, joined: false }
    this.#pings.set(key, ping)
    // A player who left moments ago and looks again.
    for (const visit of this.#visits.values())
      if (visit.leftAt !== undefined && visit.address === address && ipOf(visit.source) === ipOf(source))
        visit.pingedAfterAt ??= at.toISOString()
    setTimeout(() => {
      if (this.#pings.get(key) === ping) this.#pings.delete(key)
      if (!ping.joined) this.#look(key, address, ping)
    }, this.#times.lingerMs).unref()
  }

  /** The visit from `source`, or from the front door's end `source` names, while it is open or lingering. */
  byAddress(source: string): Visit | undefined {
    return this.#visits.get(this.#aliases.get(source) ?? source)
  }

  /** mc-router sees the visit from `source` as coming from `local`, until it closes. */
  alias(local: string, source: string): void {
    this.#aliases.set(local, source)
  }

  update(source: string, fields: Partial<Omit<Visit, 'joinId' | 'opened'>>): void {
    const visit = this.byAddress(source)
    if (visit !== undefined) Object.assign(visit, fields)
  }

  /** Sends the visit's `open` half, once. */
  open(source: string): void {
    const visit = this.byAddress(source)
    if (visit === undefined || visit.opened) return
    visit.opened = true
    this.#send(report(visit, 'open'))
  }

  /** A join turned away at the door: its whole visit, at once. */
  refused(source: string, handshake: { address: string; protocol: number }, why: string): void {
    const visit = this.arrived(source, handshake)
    this.#visits.delete(source)
    const at = this.#now().toISOString()
    this.#send(report({ ...visit, path: 'refused', leftAt: at, leftReason: `refused:${why}` }, 'close'))
  }

  /** The connection from `source` closed: its visit waits a moment for a ping, then is sent. */
  closed(source: string, bytes: { up: number; down: number }): void {
    const visit = this.#visits.get(source)
    for (const [local, aliased] of this.#aliases) if (aliased === source) this.#aliases.delete(local)
    if (visit === undefined) return
    visit.leftAt ??= this.#now().toISOString()
    visit.bytesUp = bytes.up
    visit.bytesDown = bytes.down
    setTimeout(() => {
      if (this.#visits.get(source) === visit) this.#visits.delete(source)
      this.#send(report(visit, 'close'))
    }, this.#times.lingerMs).unref()
  }

  /** A ping no join followed: a look, unless one went for it lately or the hour's are used. */
  #look(key: string, address: string, ping: Ping): void {
    const now = this.#now().getTime()
    // An address's hour is over: what it counted goes, so addresses nobody pings any more are let go.
    for (const [counted, its] of this.#looks) if (now - its.since >= HOUR_MS) this.#looks.delete(counted)
    const hour = this.#looks.get(address)
    const count = hour === undefined || now - hour.since >= HOUR_MS ? { since: now, sent: 0, more: 0 } : hour
    this.#looks.set(address, count)
    const last = this.#looked.get(key)
    if (
      (last !== undefined && now - last < this.#times.lookEveryMs) ||
      count.sent >= this.#times.looksPerHour
    ) {
      count.more++
      return
    }
    this.#looked.set(key, now)
    for (const [k, at] of this.#looked) if (now - at >= this.#times.lookEveryMs) this.#looked.delete(k)
    count.sent++
    const more = count.more
    count.more = 0
    this.#send({
      joinId: Bun.randomUUIDv7(),
      phase: 'look',
      ...this.#edge,
      address,
      source: ping.source,
      pingedAt: ping.at.toISOString(),
      connectedAt: ping.at.toISOString(),
      ...(more > 0 ? { detail: { more } } : {}),
    })
  }
}

function report(visit: Visit, phase: VisitReport['phase']): VisitReport {
  const { opened: _, ...rest } = visit
  return { ...rest, phase }
}
