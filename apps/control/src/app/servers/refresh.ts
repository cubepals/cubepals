// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server asleep with its memory kept wakes as it slept, so what its owner changed since that only
 * a start reads, its icon and its server list message (`IDENTITY_ENV`), would wait for a boot that a
 * server that only ever sleeps and wakes never has. So a change to either while it sleeps starts it
 * at once in the background, on what it should run, with nobody waiting: a run nobody joins goes
 * back to sleep after the probation (`domain/server/idle.ts`) and counts toward no hours
 * (`REFRESH_KEY`, `usage.ts`), and the copy it sleeps as then shows the change, so its next wake
 * is still a resume. A player who joins meanwhile is let in as at any start.
 *
 * Bounded as a server-list ping's wake is (`edge/ping-wake.ts`): its owner must be able to start it,
 * the hourly cap on wakes nobody joined counts it, and none starts once the owner's included hours
 * are used. Not for a server stopped without its memory, whose next start boots anyway, but two,
 * each started the same way so that it ends asleep with its memory, as it would have been: a
 * server stopped for once so that its Java could write the recording of its start
 * (`minecraft/start-cache.ts`), which makes its startup cache with nobody waiting (`recorded`),
 * and one someone played lately whose stop was meant as a sleep and couldn't be one (`cold`,
 * `operations/schedules/stale-sleep.ts`). Which servers, and when, is the caller's.
 */
import type { Db } from '@blockly/db'
import { entitlementsOf } from '../../domain/account/entitlements.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { Actor } from '../actor.ts'
import { meteredMonth } from '../billing/chip-in-meter.ts'
import { AppError } from '../errors.ts'
import { tuning } from '../tuning.ts'
import { findServer, memoryKept } from './persistence.ts'
import { READY_KEY, RECORDED_KEY, REFRESH_KEY, unjoinedWakes } from './usage.ts'

/**
 * Why a server asleep is started with nobody waiting: to show what its owner just changed of it
 * (`changed`), or with nothing of theirs asking, to keep it ready for its next join (`ready`), or
 * after the stop that let it write its start's recording (`recorded`), or after a stop that should
 * have been a sleep (`cold`). They differ in what the server's page says of the start, where
 * the last is said as `ready` is, and in that the last two have no memory kept.
 */
export type RefreshReason = 'changed' | 'ready' | 'recorded' | 'cold'

/** What each reason's start is keyed by, which is how its page and its hours tell it (`usage.ts`). */
const KEY_OF: Record<RefreshReason, string> = {
  changed: REFRESH_KEY,
  ready: READY_KEY,
  recorded: RECORDED_KEY,
  cold: READY_KEY,
}

/** The reasons to start a server that sleeps without its memory. */
const WITHOUT_MEMORY: ReadonlySet<RefreshReason> = new Set(['recorded', 'cold'])

/** Starts the server asleep where that is worth it, and says whether it did. */
export async function refreshAsleep(
  deps: { db: Db; start: (actor: Actor, serverId: string, requestId: string) => Promise<unknown> },
  serverId: string,
  why: RefreshReason = 'changed',
): Promise<boolean> {
  const { db } = deps
  const server = await findServer(db, serverId)
  if (server?.lifecycle.status !== 'stopped') return false
  if (!WITHOUT_MEMORY.has(why) && !(await memoryKept(db, serverId))) return false
  const now = new Date()
  if ((await unjoinedWakes(db, serverId, now)) >= tuning().abuse.wakesPerHour) return false
  const standing = await loadStanding(db, server.ownerId)
  const month = await meteredMonth(db, standing, entitlementsOf(standing), now)
  if (month !== null && month.units >= month.included + month.carried) return false
  try {
    // Asked as a wake, so its run is a woken one, and sleeps unjoined after the probation.
    await deps.start({ kind: 'system', reason: 'wake' }, serverId, `${KEY_OF[why]}${crypto.randomUUID()}`)
  } catch (error) {
    // Refused by the same checks as any start: its owner can't start it now.
    if (error instanceof AppError) return false
    throw error
  }
  return true
}
