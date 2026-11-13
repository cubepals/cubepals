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
 * One more kind of server is started here though it kept no memory: one whose last sleep was a
 * stop, made so that its Java could write the recording of its start
 * (`handlers/winding-down.ts`). Its start makes the startup cache with nobody waiting, and it
 * sleeps with its memory after the probation, as it would have. These go first.
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
import { lastActivity, REFRESH_KEY } from '../../servers/usage.ts'
import { activeOperation, stoppedForRecording } from '../persistence.ts'

/** How long a server has been asleep before a pass looks at it: its sleep's restore point is done by then. */
const SETTLED_MS = 10 * MINUTE_MS
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

/** How long after a stop made for a recording its start is still tried: one refused all that time is left to its next player. */
const RECORDED_MS = DAY_MS

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
  const played = await lastActivity(db, serverId)
  const lately = played !== null && played.getTime() > now.getTime() - PLAYED_MS
  return lately ? { again: KEPT_PLAYED_MS, kept: KEPT_PLAYED_MS } : { again: AGAIN_MS, kept: null }
}

export function staleSleepers(deps: {
  db: Db
  runtime: Pick<Runtimes, 'wakesWouldBoot'>
  specs: Pick<RuntimeSpecs, 'desired'>
  refresh: (serverId: string, why: 'ready' | 'recorded') => Promise<boolean>
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

  /** The servers stopped for a recording since `since` and not started after, where nothing else is going on. */
  const recorded = async (since: Date): Promise<string[]> => {
    const stopped = new Set((await listByStatus(db, 'stopped')).map((server) => server.id))
    const waiting: string[] = []
    for (const id of await stoppedForRecording(db, since)) {
      if (stopped.has(id) && (await activeOperation(db, id)) === null) waiting.push(id)
    }
    return waiting
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

  /**
   * Starts up to `limit` servers, those stopped for a recording first, then the sleeping ones to
   * refresh; how many it started.
   */
  return async (options: { limit?: number; settledMs?: number; now?: Date } = {}): Promise<number> => {
    const now = options.now ?? new Date()
    const waiting: Array<[string, 'recorded' | 'ready']> = [
      ...(await recorded(new Date(now.getTime() - RECORDED_MS))).map(
        (id) => [id, 'recorded'] as [string, 'recorded'],
      ),
      ...(await stale(now, options.settledMs ?? SETTLED_MS)).map(
        (key) => [key, 'ready'] as [string, 'ready'],
      ),
    ]
    let started = 0
    for (const [id, why] of waiting) {
      if (started >= (options.limit ?? 3)) break
      if (await refresh(id, why)) started++
    }
    return started
  }
}
