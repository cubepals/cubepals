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
 * a client's `ip:port` spelt one way by `sources.ts`; a join the game refused for its whitelist or
 * a ban is told by `refusals.ts`; signals are raised by `signals.ts`, and operators read all of it
 * through `queries.ts`.
 */
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type {
  JoinDetailView,
  JoinView,
  ServerJoinEvent,
  SignalView,
  VisitReport,
} from '@blockly/contracts/join-records'
import { type Db, schema, type Tx } from '@blockly/db'
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm'
import { z } from 'zod'
import { type OperatorActor, requestedBy } from '../actor.ts'
import { NotFound } from '../errors.ts'
import type { Limits } from '../ports/limits.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import type { SecretKeyring } from '../secrets.ts'
import { tuning } from '../tuning.ts'
import { closeSignal, findJoin, type JoinFilter, joinDetail, listJoins, listSignals } from './queries.ts'
import { recordServerEvents } from './server-events.ts'
import { raiseSignals } from './signals.ts'
import { recordVisits } from './visits.ts'

/** How long joins and the signals raised on them are kept; the Privacy Policy states it. */
export const JOINS_KEPT_DAYS = 35
/** How often `joins-sweep` runs (`infra/pg/cron.ts`). */
const SWEPT_EVERY_MS = 10 * MINUTE_MS
/**
 * How old a join's source may be when a sweep finds it: never kept past the hour, whenever the
 * next sweep comes. A join put together and over loses it at once (`putTogether`).
 */
const SOURCE_KEPT_MS = HOUR_MS - SWEPT_EVERY_MS
/** The longest a join's source can be kept, the Privacy Policy's figure: one sweep past its age. */
export const SOURCE_KEPT_AT_MOST_MS = SOURCE_KEPT_MS + SWEPT_EVERY_MS
const UUID = z.uuid()

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
    const second = Math.floor(Date.now() / SECOND_MS)
    return this.#limits.allow(`joins:${serverId}:${second}`, tuning().abuse.joinReportsPerSecond)
  }

  /** The edge's reports of the connections it saw. */
  recordVisits(reports: readonly VisitReport[]): Promise<void> {
    return this.#db.transaction(async (tx) => {
      await recordVisits(tx, { addressing: this.#addressing, ring: this.#ring }, reports)
      await putTogether(
        tx,
        reports.map((r) => r.joinId),
      )
    })
  }

  /** A server's reports of its players joining and leaving, and of its boot. */
  recordServerEvents(serverId: string, events: readonly ServerJoinEvent[]): Promise<void> {
    return this.#db.transaction(async (tx) =>
      putTogether(tx, await recordServerEvents(tx, this.#addressing, serverId, events)),
    )
  }

  /** Joins, the newest first, as an operator narrows them. */
  list(filter: JoinFilter): Promise<JoinView[]> {
    return listJoins(this.#db, filter)
  }

  /** One join with what explains it: its wake's start, its signals and how often its player came. */
  async detail(id: string): Promise<JoinDetailView> {
    return (await joinDetail(this.#db, id)) ?? notFound('Join')
  }

  /**
   * The join `ref` names: a join's own id, whatever version of uuid it is (a join only the server
   * reported has a random one, as a player's is), or else a player's join nearest `at`, or their
   * latest.
   */
  async find(ref: string, at?: Date): Promise<JoinDetailView> {
    const own = UUID.safeParse(ref).success ? await joinDetail(this.#db, ref) : null
    if (own !== null) return own
    const id = await findJoin(this.#db, ref, at)
    return id === null ? notFound('Join') : this.detail(id)
  }

  /** The open signals, oldest first; with `since`, those closed since then too. */
  signals(since?: Date): Promise<SignalView[]> {
    return listSignals(this.#db, since)
  }

  /** An operator closes a signal they have looked at. */
  async closeSignal(operator: OperatorActor, id: number): Promise<SignalView> {
    return (await closeSignal(this.#db, id, requestedBy(operator), new Date())) ?? notFound('Signal')
  }

  /** `signals`: raises what the `SIGNALS` setting finds, and closes what has been open a day. */
  raiseSignals(now = new Date()): Promise<number> {
    return raiseSignals(this.#db, now)
  }

  /**
   * `joins-sweep`: forgets joins and signals past their days, and the source of every join old
   * enough that it would be past the hour by the next sweep. How many rows it changed.
   */
  async sweep(now = new Date()): Promise<number> {
    const old = new Date(now.getTime() - JOINS_KEPT_DAYS * DAY_MS)
    const { joins, signals } = schema
    const gone = await this.#db.delete(joins).where(lt(joins.connectedAt, old)).returning({ id: joins.id })
    const closed = await this.#db.delete(signals).where(lt(signals.at, old)).returning({ id: signals.id })
    const forgotten = await this.#db
      .update(joins)
      .set({ source: null })
      .where(and(isNotNull(joins.source), lt(joins.connectedAt, new Date(now.getTime() - SOURCE_KEPT_MS))))
      .returning({ id: joins.id })
    return gone.length + closed.length + forgotten.length
  }
}

/**
 * Forgets the source of each of `ids` whose two halves are both in and whose player has left: it
 * was kept only to put the join together.
 */
async function putTogether(q: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const { joins } = schema
  await q
    .update(joins)
    .set({ source: null })
    .where(
      and(
        inArray(joins.id, [...ids]),
        isNotNull(joins.source),
        isNotNull(joins.edgeId),
        eq(joins.serverSide, 'reported'),
        isNotNull(joins.leftAt),
      ),
    )
}

const notFound = (what: string): never => {
  throw new NotFound(what)
}
