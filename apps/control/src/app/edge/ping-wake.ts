// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A wake a server-list ping starts, before anyone joins. A player who has a server saved sees it
 * in their list a moment before they click it, and a server whose start is a boot rather than a
 * resume takes long enough that this moment matters: a world at rest, or one whose sleep stopped
 * it. One whose memory was kept resumes in about as long as the click takes, and is left to it.
 *
 * Anything can ping, so it is bounded: the same policy as any start (its owner must be able to
 * start it), a woken run nobody joins sleeps after the probation (`domain/server/idle.ts`), the
 * hourly cap on wakes a connection asks for counts it, none starts once the owner's included hours
 * are used, and after one nobody joined, pings wake the server again only once
 * `AbuseLimits.pingWakeHoldHours` have passed. Not for the join's own wake, which waits for the
 * server (`service.ts`), or for what the edge says to the ping (`apps/edge`).
 */
import { HOUR_MS } from '@blockly/contracts/durations'
import type { PingWakeResult } from '@blockly/contracts/edge'
import type { Db } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { meteredMonth } from '../billing/chip-in-meter.ts'
import { AppError } from '../errors.ts'
import { openOfKinds } from '../operations/persistence.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import { findLiveBySlug, memoryKept } from '../servers/persistence.ts'
import type { MinecraftServerService } from '../servers/service.ts'
import { lastActivity, lastPingWake, PING_WAKE_KEY, wakesInLastHour } from '../servers/usage.ts'
import { tuning } from '../tuning.ts'

const WAKING: PingWakeResult = { waking: true }
const ASLEEP: PingWakeResult = { waking: false }

/** Starts the server a ping asked about where that is worth it; says whether it is on its way up. */
export async function pingWake(
  deps: { db: Db; addressing: PlayAddressing; service: Pick<MinecraftServerService, 'start'> },
  hostname: string,
): Promise<PingWakeResult> {
  const { db } = deps
  const slug = deps.addressing.slugFor(hostname)
  const server = slug === null ? null : await findLiveBySlug(db, slug)
  if (server === null) return ASLEEP
  const { status } = server.lifecycle
  if (status === 'starting') return WAKING
  // Its world coming back from rest, for a join or a ping: any other restore isn't a wake.
  if (status === 'restoring')
    return (await openOfKinds(db, [server.id], ['unstore'])).length > 0 ? WAKING : ASLEEP
  if (!(await worthWaking(db, server, new Date()))) return ASLEEP
  try {
    // Asked as a connection's wake, so its run is a woken one, and sleeps unjoined after the probation.
    await deps.service.start(
      { kind: 'system', reason: 'wake' },
      server.id,
      `${PING_WAKE_KEY}${crypto.randomUUID()}`,
    )
  } catch (error) {
    // Refused by the same checks as any start: its owner can't start it now.
    if (error instanceof AppError) return ASLEEP
    throw error
  }
  return WAKING
}

/** Whether a ping may wake `server` now: its start is a boot, and nothing above says no. */
async function worthWaking(db: Db, server: MinecraftServer, now: Date): Promise<boolean> {
  const { status } = server.lifecycle
  if (status !== 'stored' && (status !== 'stopped' || (await memoryKept(db, server.id)))) return false
  const limits = tuning().abuse
  if ((await wakesInLastHour(db, server.id, now)) >= limits.wakesPerHour) return false
  // The last one nobody joined holds off the next, so a site that pings every few minutes wakes it
  // once in that while.
  const last = await lastPingWake(db, server.id)
  if (last !== null && now.getTime() - last.getTime() < limits.pingWakeHoldHours * HOUR_MS) {
    const played = await lastActivity(db, server.id)
    if (played === null || played < last) return false
  }
  // Past its included hours, a run nobody joined would be paid for: only a join wakes it then.
  const standing = await loadStanding(db, server.ownerId)
  const month = await meteredMonth(db, standing, entitlementsFor(standing.plan, standing.limitOverrides), now)
  return month === null || month.units < month.included + month.carried
}
