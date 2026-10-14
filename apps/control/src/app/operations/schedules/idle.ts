// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Decides whether a running server nobody is on has been idle long enough for its plan, or was
 * woken by a connection nobody followed, and stops it if so. While room is tight, a free server's
 * idle time is shorter (`idleMinutesFor`). The idle check and the edge's hint
 * (`edge/service.ts`) both ask through the same decision. Reading who is online is `presence.ts`'s;
 * the stop itself is the `stop` operation's.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import { entitlementsFor } from '../../../domain/account/entitlements.ts'
import { bedtime } from '../../../domain/server/idle.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import { idleMinutesFor } from '../../platform/room.ts'
import { listByStatus } from '../../servers/persistence.ts'
import type { MinecraftServerService } from '../../servers/service.ts'
import { lastActivity, openRun, presenceFor } from '../../servers/usage.ts'

/** How long after a restart idle stops wait for presence to be read again (§15.5). */
export const IDLE_GRACE_MS = 5 * MINUTE_MS

/** How long a woken run has for somebody to join: `domain/server/idle.ts` says why, beside the rule. */
export { WAKE_PROBATION_MS } from '../../../domain/server/idle.ts'

/** What an idle evaluation decided. */
export type IdleDecision = 'grace' | 'never_idles' | 'recently_active' | 'stopped' | 'nobody_joined'

export function idleStops(deps: {
  db: Db
  service: Pick<MinecraftServerService, 'stop'>
  /** When this process started: until presence is read again after it, activity is unknown. */
  startedAt: Date
}) {
  const { db, service, startedAt } = deps

  /** Stops running servers nobody has played on for longer than their plan allows. */
  const idleCheck = async (now: Date): Promise<void> => {
    const running = await listByStatus(db, 'running')
    const online = await presenceFor(
      db,
      running.map((s) => s.id),
    )
    for (const server of running) {
      if ((online.get(server.id)?.length ?? 0) > 0) continue
      await evaluateIdle(server, now)
    }
  }

  /** Whether a server nobody is on has been idle long enough for its plan, and if so, stops it. */
  const evaluateIdle = async (server: MinecraftServer, now: Date): Promise<IdleDecision> => {
    // Just after a restart, empty presence means "not read yet", not "nobody playing" (§15.5):
    // presence-sync gets a few rounds before anything stops for being idle.
    if (now.getTime() - startedAt.getTime() < IDLE_GRACE_MS) return 'grace'
    const run = await openRun(db, server.id)
    const played = await lastActivity(db, server.id)
    const standing = await loadStanding(db, server.ownerId)
    const minutes = await idleMinutesFor(db, entitlementsFor(standing.plan, standing.limitOverrides))
    // A run a connection woke that nobody joined is stopped early, whatever the plan allows an
    // idle server: waking something has to be worth its money, and nothing here can be forged.
    // Otherwise the plan's idle time counts from this run's start or the last play in it, never
    // from a play before the server last slept.
    const due = bedtime(run, played, minutes)
    if (due === null) return minutes === null ? 'never_idles' : 'recently_active'
    if (now < due.at) return 'recently_active'
    await service.stop({ kind: 'system', reason: 'idle' }, server.id, crypto.randomUUID(), 'idle')
    if (due.why === 'nobody_joined') return 'nobody_joined'
    return 'stopped'
  }

  return { idleCheck, evaluateIdle }
}
