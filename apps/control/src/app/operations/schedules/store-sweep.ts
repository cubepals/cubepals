// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finds the servers nobody has played on for as long as their plan says and hands them, a few a
 * pass, to the `store` operation, which checks everything again before it lets anything go
 * (`handlers/stored-worlds.ts`). Deleting a world unplayed for longer still is `expiring.ts`'s.
 */
import type { Db } from '@blockly/db'
import { entitlementsFor, PLAN_KEYS } from '../../../domain/account/entitlements.ts'
import { loadControls, loadStanding } from '../../accounts/persistence.ts'
import { idleSince, lockServer } from '../../servers/persistence.ts'
import type { ServerTransitions } from '../../servers/transitions.ts'
import { latestOfKind, pendingOfKind } from '../persistence.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** How long after a world failed to rest before the store sweep tries it again. */
const STORE_RETRY_MS = DAY_MS

export function storingIdle(deps: {
  db: Db
  /** Whether worlds can rest here at all: resting needs the archive store (§15.4). */
  storing: boolean
  transitions: Pick<ServerTransitions, 'enqueue'>
}) {
  const { db, storing, transitions } = deps

  /**
   * `store-sweep`: servers nobody has played on for as long as their plan says
   * are handed to the `store` operation, a few at a time, longest idle first. The operation checks
   * everything again under the server's lock before it lets anything go; this only finds them.
   * Nothing is stored where the deployment keeps no archives, or while an admin has paused it.
   */
  const storeSweep = async (now: Date, limit: number): Promise<number> => {
    if (!storing) return 0
    if (!(await loadControls(db)).storingEnabled) return 0
    // The shortest wait any plan has: each server is then held to its own plan's.
    const shortest = Math.min(...PLAN_KEYS.map((plan) => entitlementsFor(plan).storeAfterIdleDays))
    let queued = 0
    for (const server of await idleSince(db, new Date(now.getTime() - shortest * DAY_MS), limit * 5)) {
      if (queued >= limit) break
      const standing = await loadStanding(db, server.ownerId)
      const days = entitlementsFor(standing.plan, standing.limitOverrides).storeAfterIdleDays
      if (now.getTime() - server.lastActiveAt.getTime() < days * DAY_MS) continue
      if (await pendingOfKind(db, server.id, 'store')) continue
      // One try per stretch of idleness, and another after each that ended without resting it: at
      // once after one called off (somebody played, something else waited), a day after one that
      // failed, since what failed it (a store that is down, a world too big to pack) seldom mends
      // within the hour, and every try snapshots and packs the whole world.
      const last = await latestOfKind(db, server.id, 'store')
      if (last?.status === 'failed' && now.getTime() - (last.finishedAt ?? now).getTime() < STORE_RETRY_MS)
        continue
      await db.transaction(async (tx) => {
        const locked = await lockServer(tx, server.id)
        if (locked?.lifecycle.status !== 'stopped') return
        await transitions.enqueue(tx, locked, 'store', {
          requestedBy: 'system:store',
          idempotencyKey: `store:${locked.lastActiveAt.toISOString()}:after:${last?.id ?? 'none'}`,
        })
        queued++
      })
    }
    return queued
  }

  return storeSweep
}
