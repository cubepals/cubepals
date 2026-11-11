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
 * finds out. So memory kept for `KEPT_MS` is no longer counted on, and its server is refreshed
 * too, after those whose wake is known to boot.
 *
 * A server with an operation in flight, asleep for less than `settledMs` (its sleep's restore
 * point may still be writing), or refreshed within `AGAIN_MS` is left for a later pass. A player
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
import { REFRESH_KEY } from '../../servers/usage.ts'
import { activeOperation } from '../persistence.ts'

/** How long a server has been asleep before a pass looks at it: its sleep's restore point is done by then. */
const SETTLED_MS = 10 * MINUTE_MS
/** A server refreshed this recently isn't refreshed again for the same reason; a refresh that didn't take is said once. */
export const AGAIN_MS = 6 * HOUR_MS
/**
 * How long memory kept for a sleeping server is counted on. A provider promises no resume: Fly
 * drops what it kept for a host move, maintenance or room, and goes on reading the machine
 * `suspended` until the start that boots it from its disk (docs/resume-fallback.md), so nothing
 * can be read of it beforehand. Past this, the server is refreshed: a resume of a few seconds
 * where the memory is still there, a boot where it is gone, nobody waiting for either, and then
 * asleep again on memory just kept.
 */
export const KEPT_MS = DAY_MS

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

export function staleSleepers(deps: {
  db: Db
  runtime: Pick<Runtimes, 'wakesWouldBoot'>
  specs: Pick<RuntimeSpecs, 'desired'>
  refresh: (serverId: string) => Promise<boolean>
}) {
  const { db, runtime, specs, refresh } = deps

  /** What a start of each would run now, where nothing else is going on with it. */
  const wouldRun = async (asleep: readonly Asleep[], now: Date) => {
    const specOf = new Map<RuntimeKey, RuntimeSpec>()
    const recorded = new Map<RuntimeKey, string | null>()
    const keptSince = new Map<RuntimeKey, Date>()
    for (const { server, resumesOn, keptAt } of asleep) {
      if ((await activeOperation(db, server.id)) !== null) continue
      if (await refreshedSince(db, server.id, new Date(now.getTime() - AGAIN_MS))) continue
      // A spec that can't be built now is its own start's to report, not this pass's.
      const desired = await specs.desired(db, server).catch(() => null)
      if (desired === null) continue
      specOf.set(runtimeKey(server.id), desired.spec)
      recorded.set(runtimeKey(server.id), resumesOn)
      keptSince.set(runtimeKey(server.id), keptAt)
    }
    return { specOf, recorded, keptSince }
  }

  /**
   * Refreshes up to `limit` servers whose wake would boot, then those whose memory has been kept
   * too long to count on, the longest kept first; how many it started. A runtime that can't be
   * read this pass leaves only the recorded keys to go on.
   */
  return async (options: { limit?: number; settledMs?: number; now?: Date } = {}): Promise<number> => {
    const now = options.now ?? new Date()
    const asleep = await asleepSince(db, new Date(now.getTime() - (options.settledMs ?? SETTLED_MS)))
    const { specOf, recorded, keptSince } = await wouldRun(asleep, now)
    if (specOf.size === 0) return 0
    const said = await runtime.wakesWouldBoot(specOf).catch((error: unknown) => {
      console.warn(`stale-sleep: the runtime couldn't say which wakes would boot: ${String(error)}`)
      return new Set<RuntimeKey>()
    })
    const boots = ([key, spec]: [RuntimeKey, RuntimeSpec]) => {
      const slept = recorded.get(key)
      return said.has(key) || (slept != null && spec.resumesOn !== undefined && slept !== spec.resumesOn)
    }
    const keptAt = (key: RuntimeKey) => keptSince.get(key)?.getTime() ?? now.getTime()
    const keptLong = [...specOf]
      .filter((entry) => !boots(entry) && keptAt(entry[0]) <= now.getTime() - KEPT_MS)
      .sort(([a], [b]) => keptAt(a) - keptAt(b))
    const stale = [...[...specOf].filter(boots), ...keptLong]
    let refreshed = 0
    for (const [key] of stale) {
      if (refreshed >= (options.limit ?? 3)) break
      if (await refresh(key)) refreshed++
    }
    return refreshed
  }
}
