// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `stale-sleep`: a server asleep with its memory wakes as it slept only while what a start of it
 * would run still matches what it went to sleep on (`resumesOn`). Anything that moves that key
 * while it sleeps (a deploy, a new pin, the owner's change, something nobody named) would make the
 * player who next joins wait out a full boot. So each pass finds the servers whose wake would boot
 * and refreshes them first, in the background, a few at a time: booted on what they should run,
 * then asleep again after the probation, so that the player's wake resumes (`servers/refresh.ts`,
 * which also bounds how often and on whose hours).
 *
 * Two readings, either enough: the runtime's own, where it can say (`wakesWouldBoot`, Fly's
 * machines), and the key its last boot recorded (`applied.resumesOn`). A third covers what neither
 * can read: memory the provider dropped while its machine still reads asleep, which only a start
 * finds out. A server someone played within `PLAYED_MS` is the one a player is likeliest to come
 * back to, so its memory is counted on for `KEPT_PLAYED_MS` only, and it is refreshed then, after
 * those whose wake is known to boot. One nobody played that lately is left asleep: a refresh would
 * boot it for memory that is gone again before anyone comes, and its next player's start boots
 * either way.
 *
 * Last come the servers that should be asleep with their memory and aren't: someone played one
 * within `PLAYED_MS`, its stop was meant as a sleep, and the server itself couldn't take it
 * (`UNSLEPT`), so it was stopped for real and its next join would boot. It is started the same
 * way once the stop is `settledMs` old, as an hourly refresh starts a server its owner stopped,
 * and never the minute after their Stop. Once a stop: its start is then the newest thing asked of
 * the server, and the stop that ends a run a refresh began and nobody played is never refreshed,
 * so a sleep refused a second time is left as it is.
 *
 * A server with an operation in flight, asleep for less than `settledMs` (its sleep's restore
 * point may still be writing), or refreshed within `AGAIN_MS` (within `KEPT_PLAYED_MS` where it was
 * played lately) is left for a later pass. A player
 * who joins while it refreshes is let in as at any start. It decides only what to refresh; why a
 * wake booted is recorded on the wake itself (`changed:*`, `servers/resume-parts.ts`).
 */
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { type Db, schema } from '@blockly/db'
import { and, eq, gt, inArray, isNotNull, like } from 'drizzle-orm'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { type RuntimeKey, type RuntimeSpec, runtimeKey } from '../../ports/runtime.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { listByStatus } from '../../servers/persistence.ts'
import type { RuntimeSpecs } from '../../servers/specs.ts'
import { lastActivity, REFRESH_KEY, refreshes } from '../../servers/usage.ts'
import { activeOperation, lastStopsMarked, latestOfKind, pendingOfKind } from '../persistence.ts'
import type { SleepMark } from '../runner.ts'

/** How long a server has been asleep, or stopped where a sleep was meant, before a pass looks at it: its restore point is done by then. */
export const SETTLED_MS = 10 * MINUTE_MS
/** A server refreshed this recently isn't refreshed again for the same reason; a refresh that didn't take is said once. */
export const AGAIN_MS = 6 * HOUR_MS
/** How lately someone played a server for its kept memory to be looked after: its players come back. */
export const PLAYED_MS = 2 * DAY_MS
/**
 * How long memory kept for a server played that lately is counted on. A provider promises no
 * resume: Fly drops what it kept for a host move, maintenance or room, and goes on reading the
 * machine `suspended` until the start that boots it from its disk (docs/resume-fallback.md), so
 * nothing can be read of it beforehand. Fly kept every one of production's for 1.3 hours or less
 * where measured (2026-11), and none for 4.5 hours or more: six of six were gone at a day. Past
 * this, the server is refreshed: a resume of a few seconds where the memory is still there, a boot
 * where it is gone, nobody waiting for either, and then asleep again on memory just kept.
 */
export const KEPT_PLAYED_MS = HOUR_MS
/**
 * How a stop that was meant as a sleep says the server itself couldn't take it (`SleepMark`):
 * someone was on it as it went, its world wasn't saved, or its files weren't written through. The
 * next sleep may well be taken. Not `runtime_stopped`: it is also what every sleep says while the
 * runtime's switch is off, when a second one is stopped as surely as the first and its boot is
 * spent for nothing. Nor a stop that was never to be a sleep (`stop_reason`, `no_sleep`), or one
 * followed by a start of its own (`recording`, `recorded-starts.ts`).
 */
const UNSLEPT = ['players_on', 'unsaved', 'unsynced'] as const satisfies readonly SleepMark[]

const runtimes = schema.serverRuntimes
const operations = schema.serverOperations

interface Asleep {
  server: MinecraftServer
  /** The key its last boot recorded, where it did. */
  resumesOn: string | null
  /** Since when its memory has been kept. */
  keptAt: Date
}

/** The servers asleep with their memory since before `before`, with the key each last booted on. */
async function asleepSince(db: Db, before: Date): Promise<Asleep[]> {
  const stopped = await listByStatus(db, 'stopped')
  if (stopped.length === 0) return []
  const rows = await db
    .select({ id: runtimes.serverId, keptAt: runtimes.memoryKeptAt, applied: runtimes.applied })
    .from(runtimes)
    .where(
      and(
        inArray(
          runtimes.serverId,
          stopped.map((s) => s.id),
        ),
        isNotNull(runtimes.memoryKeptAt),
      ),
    )
  const kept = new Map(rows.filter((r) => r.keptAt !== null && r.keptAt <= before).map((r) => [r.id, r]))
  return stopped.flatMap((server) => {
    const row = kept.get(server.id)
    return row === undefined || row.keptAt === null
      ? []
      : [{ server, resumesOn: row.applied?.resumesOn ?? null, keptAt: row.keptAt }]
  })
}

/** Whether the server was refreshed since `since`, whatever came of it. */
async function refreshedSince(db: Db, serverId: string, since: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: operations.id })
    .from(operations)
    .where(
      and(
        eq(operations.serverId, serverId),
        like(operations.idempotencyKey, `start:${REFRESH_KEY}%`),
        gt(operations.createdAt, since),
      ),
    )
    .limit(1)
  return row !== undefined
}

/** When someone last played the server, where that is within `PLAYED_MS`; null otherwise. */
async function playedLately(db: Db, serverId: string, now: Date): Promise<Date | null> {
  const played = await lastActivity(db, serverId)
  return played !== null && played.getTime() > now.getTime() - PLAYED_MS ? played : null
}

/**
 * How long the server's kept memory is counted on, and how soon after a refresh it may have
 * another. Only where someone played it lately is its memory refreshed for having been kept long:
 * `kept` is null for any other.
 */
async function boundsOf(
  db: Db,
  serverId: string,
  now: Date,
): Promise<{ again: number; kept: number | null }> {
  const lately = (await playedLately(db, serverId, now)) !== null
  return lately ? { again: KEPT_PLAYED_MS, kept: KEPT_PLAYED_MS } : { again: AGAIN_MS, kept: null }
}

/**
 * Whether someone played the server lately, and not only before the refresh that began its last
 * run, where one did: a run a refresh began and nobody played ends in that refresh's own stop.
 */
async function playedItsRun(db: Db, serverId: string, now: Date): Promise<boolean> {
  const played = await playedLately(db, serverId, now)
  if (played === null) return false
  const began = await latestOfKind(db, serverId, 'start')
  return began === null || !refreshes(began) || played > began.createdAt
}

/**
 * The servers stopped where a sleep was meant (`UNSLEPT`) at least `settledMs` ago, the longest
 * stopped first: someone played each lately, nothing has been asked of it since but background
 * work, and nothing is in flight, the restore point of that stop included, since the copy is of
 * the server as it stopped. None has its memory kept: the sleep that would have kept it is the one
 * refused. No stop older than `PLAYED_MS` is read: nobody played the server after the stop that
 * left it stopped.
 */
async function unslept(db: Db, now: Date, settledMs: number): Promise<string[]> {
  const stops = await lastStopsMarked(db, new Date(now.getTime() - PLAYED_MS), UNSLEPT)
  const cold: string[] = []
  for (const { serverId, at } of stops) {
    if (at.getTime() > now.getTime() - settledMs) continue
    if ((await activeOperation(db, serverId)) !== null) continue
    if (await pendingOfKind(db, serverId, 'backup')) continue
    if (await playedItsRun(db, serverId, now)) cold.push(serverId)
  }
  return cold
}

export function staleSleepers(deps: {
  db: Db
  runtime: Pick<Runtimes, 'wakesWouldBoot'>
  specs: Pick<RuntimeSpecs, 'desired'>
  /** Starts it in the background where that is allowed: asleep with its memory (`ready`), or without (`cold`). */
  refresh: (serverId: string, why: 'ready' | 'cold') => Promise<boolean>
}) {
  const { db, runtime, specs, refresh } = deps

  /** What a start of each would run now, where nothing else is going on with it. */
  const wouldRun = async (asleep: readonly Asleep[], now: Date) => {
    const specOf = new Map<RuntimeKey, RuntimeSpec>()
    const recorded = new Map<RuntimeKey, string | null>()
    const keptSince = new Map<RuntimeKey, Date>()
    const countedOn = new Map<RuntimeKey, number>()
    for (const { server, resumesOn, keptAt } of asleep) {
      if ((await activeOperation(db, server.id)) !== null) continue
      const { again, kept } = await boundsOf(db, server.id, now)
      if (await refreshedSince(db, server.id, new Date(now.getTime() - again))) continue
      // A spec that can't be built now is its own start's to report, not this pass's.
      const desired = await specs.desired(db, server).catch(() => null)
      if (desired === null) continue
      specOf.set(runtimeKey(server.id), desired.spec)
      recorded.set(runtimeKey(server.id), resumesOn)
      keptSince.set(runtimeKey(server.id), keptAt)
      if (kept !== null) countedOn.set(runtimeKey(server.id), kept)
    }
    return { specOf, recorded, keptSince, countedOn }
  }

  /**
   * The sleeping servers to refresh: those whose wake would boot, then those played lately whose
   * memory has been kept too long to count on, the longest kept first. A runtime that can't be
   * read this pass leaves only the recorded keys to go on.
   */
  const stale = async (now: Date, settledMs: number): Promise<RuntimeKey[]> => {
    const asleep = await asleepSince(db, new Date(now.getTime() - settledMs))
    const { specOf, recorded: sleptOn, keptSince, countedOn } = await wouldRun(asleep, now)
    if (specOf.size === 0) return []
    const said = await runtime.wakesWouldBoot(specOf).catch((error: unknown) => {
      console.warn(`stale-sleep: the runtime couldn't say which wakes would boot: ${String(error)}`)
      return new Set<RuntimeKey>()
    })
    const boots = ([key, spec]: [RuntimeKey, RuntimeSpec]) => {
      const slept = sleptOn.get(key)
      return said.has(key) || (slept != null && spec.resumesOn !== undefined && slept !== spec.resumesOn)
    }
    const keptAt = (key: RuntimeKey) => keptSince.get(key)?.getTime() ?? now.getTime()
    const keptLong = [...specOf]
      .filter((entry) => {
        const counted = countedOn.get(entry[0])
        return !boots(entry) && counted !== undefined && keptAt(entry[0]) <= now.getTime() - counted
      })
      .sort(([a], [b]) => keptAt(a) - keptAt(b))
    return [...[...specOf].filter(boots), ...keptLong].map(([key]) => key)
  }

  /** Refreshes up to `limit` of them, the sleeping first, then those stopped where a sleep was meant; how many it started. */
  return async (options: { limit?: number; settledMs?: number; now?: Date } = {}): Promise<number> => {
    const now = options.now ?? new Date()
    const settledMs = options.settledMs ?? SETTLED_MS
    const asked = [
      ...(await stale(now, settledMs)).map((key) => [key, 'ready'] as const),
      ...(await unslept(db, now, settledMs)).map((id) => [id, 'cold'] as const),
    ]
    let refreshed = 0
    for (const [id, why] of asked) {
      if (refreshed >= (options.limit ?? 3)) break
      if (await refresh(id, why)) refreshed++
    }
    return refreshed
  }
}
