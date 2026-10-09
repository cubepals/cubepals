/**
 * Decides whether a running server nobody is on has been idle long enough for its plan, or was
 * woken by a connection nobody followed, and stops it if so. The idle check and the edge's hint
 * (`edge/service.ts`) both ask through the same decision. Reading who is online is `presence.ts`'s;
 * the stop itself is the `stop` operation's.
 */
import type { Db } from '@blockly/db'
import { entitlementsFor } from '../../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import { loadStanding } from '../../accounts/persistence.ts'
import { listByStatus } from '../../servers/persistence.ts'
import type { MinecraftServerService } from '../../servers/service.ts'
import { lastActivity, openRun, presenceFor } from '../../servers/usage.ts'

/** How long after a restart idle stops wait for presence to be read again (§15.5). */
export const IDLE_GRACE_MS = 5 * 60_000

/**
 * How long a run that a connection woke has to see somebody actually join (§15.1). A forged
 * login costs one connection and would otherwise buy a whole idle window of billed compute —
 * ten minutes on free, fifteen on Plus.
 *
 * Five minutes, not two, and the reason is what a real join looks like: a world that takes
 * longer to load than the edge will hold the connection open gets dropped mid-wake, and the
 * player tries again. A smoke run caught exactly that — woken at 11:26, the connection closed
 * at 11:27 while it was still loading, and the probation stopped it at 11:29, before anyone
 * could come back. The window has to cover somebody noticing and clicking Join a second time.
 * It still cuts an abusive wake from ten minutes to five on free, and from fifteen to five on
 * Plus, and nothing about it can be forged: only a login that completes ends the probation. On a
 * server whose owner turned off account checks, completing one takes no account, only a name the
 * server lets in.
 */
export const WAKE_PROBATION_MS = 5 * 60_000

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
    // A run a connection woke that nobody joined is stopped early, whatever the plan allows an
    // idle server: waking something has to be worth its money, and nothing here can be forged.
    if (
      run?.woken &&
      (played === null || played < run.startedAt) &&
      now.getTime() - run.startedAt.getTime() >= WAKE_PROBATION_MS
    ) {
      await service.stop({ kind: 'system', reason: 'idle' }, server.id, crypto.randomUUID(), 'idle')
      return 'nobody_joined'
    }
    const standing = await loadStanding(db, server.ownerId)
    const minutes = entitlementsFor(standing.plan, standing.limitOverrides).idleShutdownAfterMinutes
    if (minutes === null) return 'never_idles'
    const since = played ?? run?.startedAt ?? null
    if (since === null || now.getTime() - since.getTime() < minutes * 60_000) return 'recently_active'
    await service.stop({ kind: 'system', reason: 'idle' }, server.id, crypto.randomUUID(), 'idle')
    return 'stopped'
  }

  return { idleCheck, evaluateIdle }
}
