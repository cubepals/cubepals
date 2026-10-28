// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How long a wake takes, by the way the server wakes: a resume of one asleep with its memory kept,
 * a boot of one whose sleep stopped it, and a restore of a world at rest. Each is the median of the
 * wakes that way that succeeded in the last `WAKE_TIMES_DAYS` days, from the ask to running: the
 * server's own where it has woken that way often enough, else every server's. What a waiting player
 * is told to expect (the server list's line while it wakes, the server page's countdown), so
 * nothing is said without measurements: a way with too few gives no number.
 *
 * Not for telling a wake's way while it runs (`wakePathOf`, from its steps so far), or for health's
 * own medians (`platform/health-persistence.ts`).
 */
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { type Queryable, schema } from '@blockly/db'
import { sql } from 'drizzle-orm'
import type { OperationKind, ServerStatus } from '../../domain/server/lifecycle.ts'
import { inFull } from '../errors.ts'
import { lastWakeSeconds, resumedWake, wakePathOf } from './persistence.ts'

const operations = schema.serverOperations

export type WakeWay = 'resume' | 'boot' | 'restore'

/** How far back wakes are counted: long enough for a quiet server to have a few, recent enough to be today's. */
export const WAKE_TIMES_DAYS = 30
/** A server's own wakes one way count once it has this many; one or two say more about chance than the server. */
const OWN_ENOUGH = 3
/** Every server's wakes one way count once there are this many. */
const ALL_ENOUGH = 5
/** How long one reading of every median stands before it is read again. */
const KEPT_MS = 10 * MINUTE_MS

/** The way a sleeping server would wake now: from rest, from memory kept, or from a boot. */
export function wayOf(status: ServerStatus, memoryKept: boolean): WakeWay {
  if (status === 'stored' || status === 'restoring' || status === 'storing') return 'restore'
  return memoryKept ? 'resume' : 'boot'
}

/** Medians in seconds: each server's own by way, and every server's by way. */
export interface WakeMedians {
  own: Map<string, number>
  all: Map<WakeWay, number>
}

const ownKey = (serverId: string, way: WakeWay) => `${serverId} ${way}`

/** The median for a server's wake one way, in whole seconds, or null with too few measured. */
export function medianOf(medians: WakeMedians, serverId: string, way: WakeWay): number | null {
  const seconds = medians.own.get(ownKey(serverId, way)) ?? medians.all.get(way)
  return seconds === undefined ? null : Math.max(1, Math.round(seconds))
}

/**
 * Reads the medians from the wakes of the last `WAKE_TIMES_DAYS` days, each server's own and every
 * server's. A start resumed by its steps (`resumedWake`), booted otherwise; an `unstore` is a world
 * back from rest, its boot included. Read through `WakeTimes`, which keeps a reading.
 */
export async function readWakeMedians(q: Queryable): Promise<WakeMedians> {
  const since = new Date(Date.now() - WAKE_TIMES_DAYS * DAY_MS)
  const { rows } = await q.execute<{ server_id: string | null; way: WakeWay; median: number; n: number }>(sql`
    with wakes as (
      select ${operations.serverId} as server_id,
             case when ${operations.kind} = 'unstore' then 'restore'
                  when ${resumedWake} then 'resume' else 'boot' end as way,
             extract(epoch from ${operations.finishedAt} - ${operations.createdAt}) as seconds
        from ${operations}
       where ${operations.kind} in ('start', 'unstore')
         and ${operations.status} = 'succeeded'
         and ${operations.finishedAt} is not null
         and ${operations.createdAt} >= ${since.toISOString()}
    )
    select case when grouping(server_id) = 0 then server_id::text end as server_id, way,
           percentile_cont(0.5) within group (order by seconds)::float8 as median, count(*)::int as n
      from wakes
     group by grouping sets ((server_id, way), (way))`)
  const medians: WakeMedians = { own: new Map(), all: new Map() }
  for (const row of rows) {
    if (row.server_id === null) {
      if (row.n >= ALL_ENOUGH) medians.all.set(row.way, row.median)
    } else if (row.n >= OWN_ENOUGH) medians.own.set(ownKey(row.server_id, row.way), row.median)
  }
  return medians
}

/**
 * What a server's first resume is told to expect: Fly resumed in under a second, and a player was in
 * the world within 2 s.
 */
const FIRST_RESUME_SECONDS = 2

/**
 * While a server wakes, how long a wake the same way takes: from sleep with its memory kept while
 * it resumes, from a boot otherwise, a resume its provider turned into a boot included, and from
 * rest. Without enough wakes measured, its last one the same way, and a first resume expects what
 * resumes measured. Null while it isn't waking. The server page's countdown counts down from it.
 */
export async function expectedWake(
  q: Queryable,
  times: Pick<WakeTimes, 'medians'>,
  serverId: string,
  operation: { id: string; kind: OperationKind } | null,
): Promise<number | null> {
  if (operation?.kind !== 'start' && operation?.kind !== 'unstore') return null
  const path = operation.kind === 'start' ? await wakePathOf(q, operation.id) : null
  const way: WakeWay = path === null ? 'restore' : path === 'resumed' ? 'resume' : 'boot'
  const median = medianOf(await times.medians(), serverId, way)
  if (median !== null || path === null) return median
  const last = await lastWakeSeconds(q, serverId, path)
  return last ?? (path === 'resumed' ? FIRST_RESUME_SECONDS : null)
}

/**
 * Every server's medians, read again at most every `KEPT_MS`: the edge asks for routes each second,
 * and a waking server's page about as often.
 */
export class WakeTimes {
  readonly #db: Queryable
  readonly #now: () => number
  #read: { at: number; medians: Promise<WakeMedians> } | null = null

  constructor(db: Queryable, now: () => number = Date.now) {
    this.#db = db
    this.#now = now
  }

  /** A read that fails gives none, so the routes go out without times, and is tried again at the next ask. */
  medians(): Promise<WakeMedians> {
    const now = this.#now()
    if (this.#read === null || now - this.#read.at >= KEPT_MS) {
      const medians: Promise<WakeMedians> = readWakeMedians(this.#db).catch((error) => {
        console.warn(`wake times: couldn't read them (${inFull(error)})`)
        if (this.#read?.medians === medians) this.#read = null
        return { own: new Map(), all: new Map() }
      })
      this.#read = { at: now, medians }
    }
    return this.#read.medians
  }
}

const readings = new WeakMap<Queryable, WakeTimes>()

/** The one reading kept for `db`: the edge's routes and the server pages count from the same. */
export function wakeTimesOf(db: Queryable): WakeTimes {
  const kept = readings.get(db)
  if (kept !== undefined) return kept
  const times = new WakeTimes(db)
  readings.set(db, times)
  return times
}
