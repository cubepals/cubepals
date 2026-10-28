// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Decides whether a running server nobody is on has been idle long enough for its plan, or was
 * woken by a connection nobody followed, and stops it if so. While room is tight, a free server's
 * idle time is shorter (`idleMinutesFor`). The idle check and the edge's hint
 * (`edge/service.ts`) both ask through the same decision. Only the server's own reading says
 * someone is on; a connect the edge saw since is a claim, and waits one reading for the server to
 * confirm it. Reading who is online is `presence.ts`'s; the stop itself is the `stop` operation's,
 * which calls an idle stop off when it finds someone in the game.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import { entitlementsOf } from '../../../domain/account/entitlements.ts'
import { bedtime } from '../../../domain/server/idle.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import { idleMinutesFor } from '../../platform/room.ts'
import { listByStatus } from '../../servers/persistence.ts'
import type { MinecraftServerService } from '../../servers/service.ts'
import { lastActivity, openRun, presenceOn } from '../../servers/usage.ts'

/** How long after a restart idle stops wait for presence to be read again (§15.5). */
export const IDLE_GRACE_MS = 5 * MINUTE_MS

/** How long a woken run has for somebody to join: `domain/server/idle.ts` says why, beside the rule. */
export { WAKE_PROBATION_MS } from '../../../domain/server/idle.ts'

/**
 * What an idle evaluation decided. `players_online`: the server's own reading found someone on.
 * `joining`: it was due, but the edge says someone connected since that reading, so it waits one
 * more reading for the server to see them.
 */
export type IdleDecision =
  | 'grace'
  | 'never_idles'
  | 'recently_active'
  | 'stopped'
  | 'nobody_joined'
  | 'players_online'
  | 'joining'

export function idleStops(deps: {
  db: Db
  service: Pick<MinecraftServerService, 'stop'>
  /** When this process started: until presence is read again after it, activity is unknown. */
  startedAt: Date
}) {
  const { db, service, startedAt } = deps
  /**
   * Per server, the run a connect the edge saw last put its stop off in, and when somebody had
   * last played then. A connect is only what a client claims, so it buys one reading for the
   * server to see someone, and the next only once the server has seen somebody play since.
   */
  const waited = new Map<string, { run: number; played: number | null }>()

  /** Stops running servers nobody has played on for longer than their plan allows. */
  const idleCheck = async (now: Date): Promise<void> => {
    // Each server's presence is read at its own turn, in `evaluateIdle`: a player can join one
    // while the pass is busy with another.
    for (const server of await listByStatus(db, 'running')) await evaluateIdle(server, now)
  }

  /** Whether a server nobody is on has been idle long enough for its plan, and if so, stops it. */
  const evaluateIdle = async (server: MinecraftServer, now: Date): Promise<IdleDecision> => {
    const online = await presenceOn(db, server.id)
    if (online.read > 0) return 'players_online'
    // Just after a restart, empty presence means "not read yet", not "nobody playing" (§15.5):
    // presence-sync gets a few rounds before anything stops for being idle.
    if (now.getTime() - startedAt.getTime() < IDLE_GRACE_MS) return 'grace'
    const { run, played, minutes, due } = await bedtimeOf(server)
    if (due === null) return minutes === null ? 'never_idles' : 'recently_active'
    if (now < due.at) return 'recently_active'
    if (mayWait(server.id, online.claimed, run, played)) return 'joining'
    await service.stop({ kind: 'system', reason: 'idle' }, server.id, crypto.randomUUID(), 'idle')
    if (due.why === 'nobody_joined') return 'nobody_joined'
    return 'stopped'
  }

  /** When a server nobody is on goes to sleep, and what that was reckoned from. */
  const bedtimeOf = async (server: MinecraftServer) => {
    const run = await openRun(db, server.id)
    const played = await lastActivity(db, server.id)
    const standing = await loadStanding(db, server.ownerId)
    const minutes = await idleMinutesFor(db, entitlementsOf(standing))
    // A run a connection woke that nobody joined is stopped early, whatever the plan allows an
    // idle server: waking something has to be worth its money, and nothing here can be forged.
    // Otherwise the plan's idle time counts from this run's start or the last play in it, never
    // from a play before the server last slept.
    return { run, played, minutes, due: bedtime(run, played, minutes) }
  }

  /**
   * Whether the `claimed` connects the edge saw since the last reading may put this run's stop off
   * once more, and if so, notes that they did.
   */
  const mayWait = (
    serverId: string,
    claimed: number,
    run: { startedAt: Date } | null,
    played: Date | null,
  ): boolean => {
    if (claimed === 0 || run === null) return false
    const last = waited.get(serverId)
    const playedSince =
      last !== undefined && played !== null && (last.played === null || played.getTime() > last.played)
    if (last !== undefined && last.run === run.startedAt.getTime() && !playedSince) return false
    waited.set(serverId, { run: run.startedAt.getTime(), played: played?.getTime() ?? null })
    return true
  }

  return { idleCheck, evaluateIdle }
}
