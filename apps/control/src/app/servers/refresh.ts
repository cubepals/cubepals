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
 * are used. Not for a server stopped without its memory, whose next start boots anyway.
 */
import type { Db } from '@blockly/db'
import { entitlementsOf } from '../../domain/account/entitlements.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { Actor } from '../actor.ts'
import { meteredMonth } from '../billing/chip-in-meter.ts'
import { AppError } from '../errors.ts'
import { tuning } from '../tuning.ts'
import { findServer, memoryKept } from './persistence.ts'
import { REFRESH_KEY, unjoinedWakes } from './usage.ts'

/** Starts the server asleep to show what its owner just changed of it, where that is worth it; says whether it did. */
export async function refreshAsleep(
  deps: { db: Db; start: (actor: Actor, serverId: string, requestId: string) => Promise<unknown> },
  serverId: string,
): Promise<boolean> {
  const { db } = deps
  const server = await findServer(db, serverId)
  if (server?.lifecycle.status !== 'stopped' || !(await memoryKept(db, serverId))) return false
  const now = new Date()
  if ((await unjoinedWakes(db, serverId, now)) >= tuning().abuse.wakesPerHour) return false
  const standing = await loadStanding(db, server.ownerId)
  const month = await meteredMonth(db, standing, entitlementsOf(standing), now)
  if (month !== null && month.units >= month.included + month.carried) return false
  try {
    // Asked as a wake, so its run is a woken one, and sleeps unjoined after the probation.
    await deps.start({ kind: 'system', reason: 'wake' }, serverId, `${REFRESH_KEY}${crypto.randomUUID()}`)
  } catch (error) {
    // Refused by the same checks as any start: its owner can't start it now.
    if (error instanceof AppError) return false
    throw error
  }
  return true
}
