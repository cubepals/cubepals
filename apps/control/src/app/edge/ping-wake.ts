// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A wake a server-list ping starts, before anyone joins. A player who has a server saved sees it
 * in their list a moment before they click it, and a boot takes long enough that this moment
 * matters. A server asleep on kept memory is woken too: the provider can drop that memory unseen,
 * and nothing says so before the start, so its wake may be a boot as well; where the memory is
 * there, it is up before the click.
 *
 * Anything on the internet can ping, scanners and sites that list servers included, so a ping wakes
 * a server only from a network its own players joined it from lately (`known-addresses.ts`); every
 * other ping hears it sleeps, and a join wakes it as always. A world at rest never comes back for a
 * ping: it rests because its players stopped coming, so a ping is mostly their list refreshing on
 * the way to another server, and a restore brings the whole world back from storage, the slowest
 * wake there is, with nobody there to play.
 *
 * Bounded besides: the same policy as any start (its owner must be able to start it), a woken run
 * nobody joins sleeps after the probation (`domain/server/idle.ts`) and counts toward no hours
 * (`countedFrom`, `accounts/persistence.ts`), the hourly cap on wakes nobody joined counts
 * it, none starts once the owner's included hours are used, and after one nobody joined, pings wake
 * the server again only once `AbuseLimits.pingWakeHoldHours` have passed. Not for the join's own
 * wake, which waits for the server (`service.ts`), or for what the edge says to the ping
 * (`apps/edge`).
 */
import { HOUR_MS } from '@blockly/contracts/durations'
import type { PingWakeResult } from '@blockly/contracts/edge'
import type { Db } from '@blockly/db'
import { entitlementsOf } from '../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { meteredMonth } from '../billing/chip-in-meter.ts'
import { AppError } from '../errors.ts'
import { openOfKinds } from '../operations/persistence.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import type { SecretKeyring } from '../secrets.ts'
import { findLiveBySlug } from '../servers/persistence.ts'
import type { MinecraftServerService } from '../servers/service.ts'
import { lastActivity, lastPingWake, PING_WAKE_KEY, unjoinedWakes } from '../servers/usage.ts'
import { tuning } from '../tuning.ts'
import { knownAddress } from './known-addresses.ts'

const WAKING: PingWakeResult = { waking: true }
const ASLEEP: PingWakeResult = { waking: false }

/**
 * Starts the server a ping from `address` asked about where that is worth it; says whether it is
 * on its way up. A ping with no address, as from an edge from before it said one, wakes nothing.
 */
export async function pingWake(
  deps: {
    db: Db
    addressing: PlayAddressing
    service: Pick<MinecraftServerService, 'start'>
    keyring: SecretKeyring
  },
  hostname: string,
  address?: string,
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
  if (!(await worthWaking(deps, server, address, new Date()))) return ASLEEP
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

/**
 * Whether a ping from `address` may wake `server` now: it sleeps rather than rests, the ping comes
 * from its own players' network, and nothing above says no.
 */
async function worthWaking(
  { db, keyring }: { db: Db; keyring: SecretKeyring },
  server: MinecraftServer,
  address: string | undefined,
  now: Date,
): Promise<boolean> {
  if (server.lifecycle.status !== 'stopped') return false
  if (!(await knownAddress(db, keyring, server.id, address, now))) return false
  const limits = tuning().abuse
  if ((await unjoinedWakes(db, server.id, now)) >= limits.wakesPerHour) return false
  // The last one nobody joined holds off the next, so a player whose list pings it on the way to
  // other servers wakes it once in that while.
  const last = await lastPingWake(db, server.id)
  if (last !== null && now.getTime() - last.getTime() < limits.pingWakeHoldHours * HOUR_MS) {
    const played = await lastActivity(db, server.id)
    if (played === null || played < last) return false
  }
  // Past its included hours, a run nobody joined would be paid for: only a join wakes it then.
  const standing = await loadStanding(db, server.ownerId)
  const month = await meteredMonth(db, standing, entitlementsOf(standing), now)
  return month === null || month.units < month.included + month.carried
}
