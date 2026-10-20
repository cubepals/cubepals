// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every join as one row (`joins`), put together from what the edge saw of the connection and what
 * the game server saw of the player, so one row says who joined what, through which address, and
 * when each step of joining happened. What a client's address was is kept only while the halves
 * are matched, an hour at most; then only a hash of its network remains. Rows go after 35 days.
 *
 * The edge's half is written by `visits.ts`, the server's matched to it by `server-events.ts`, and
 * a client's `ip:port` spelt one way by `sources.ts`.
 */
import { DAY_MS, HOUR_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { ServerJoinEvent, VisitReport } from '@blockly/contracts/join-records'
import { type Db, schema } from '@blockly/db'
import { and, eq, isNotNull, lt, or } from 'drizzle-orm'
import type { Limits } from '../ports/limits.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import type { SecretKeyring } from '../secrets.ts'
import { recordServerEvents } from './server-events.ts'
import { recordVisits } from './visits.ts'

/** How long joins and the signals raised on them are kept. */
const JOINS_KEPT_DAYS = 35
/** The most reports one server may post a second; past that its reporter's posts are refused. */
const REPORTS_PER_SECOND = 10
/** How long a client's `ip:port` is kept on its join, at the most. */
const SOURCE_KEPT_MS = HOUR_MS

export class JoinService {
  readonly #db: Db
  readonly #addressing: PlayAddressing
  readonly #ring: SecretKeyring
  readonly #limits: Limits

  constructor(deps: {
    db: Db
    addressing: PlayAddressing
    /** The runtime keyring, which keys each network's hash to its server (`known-addresses.ts`). */
    runtimeSecrets: SecretKeyring
    limits: Limits
  }) {
    this.#db = deps.db
    this.#addressing = deps.addressing
    this.#ring = deps.runtimeSecrets
    this.#limits = deps.limits
  }

  /** Whether `serverId` may post another report this second, counting it when it may. */
  mayReport(serverId: string): Promise<boolean> {
    // Each second its own count: the limits' window is longer than one.
    return this.#limits.allow(`joins:${serverId}:${Math.floor(Date.now() / SECOND_MS)}`, REPORTS_PER_SECOND)
  }

  /** The edge's reports of the connections it saw. */
  recordVisits(reports: readonly VisitReport[]): Promise<void> {
    return this.#db.transaction((tx) =>
      recordVisits(tx, { addressing: this.#addressing, ring: this.#ring }, reports),
    )
  }

  /** A server's reports of its players joining and leaving, and of its boot. */
  recordServerEvents(serverId: string, events: readonly ServerJoinEvent[]): Promise<void> {
    return this.#db.transaction((tx) => recordServerEvents(tx, this.#addressing, serverId, events))
  }

  /**
   * `joins-sweep`: forgets joins and signals past their days, and the source of every join put
   * together or older than an hour. How many rows it changed.
   */
  async sweep(now = new Date()): Promise<number> {
    const old = new Date(now.getTime() - JOINS_KEPT_DAYS * DAY_MS)
    const { joins, signals } = schema
    const gone = await this.#db.delete(joins).where(lt(joins.connectedAt, old)).returning({ id: joins.id })
    const closed = await this.#db.delete(signals).where(lt(signals.at, old)).returning({ id: signals.id })
    const matched = and(eq(joins.serverSide, 'reported'), isNotNull(joins.leftAt))
    const forgotten = await this.#db
      .update(joins)
      .set({ source: null })
      .where(
        and(
          isNotNull(joins.source),
          or(lt(joins.connectedAt, new Date(now.getTime() - SOURCE_KEPT_MS)), matched),
        ),
      )
      .returning({ id: joins.id })
    return gone.length + closed.length + forgotten.length
  }
}
