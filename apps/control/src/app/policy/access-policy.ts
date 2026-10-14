// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { backAtMidnight } from '@blockly/contracts/play-today'
import type { Tx } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { extraUnits } from '../../domain/account/extra-play.ts'
import {
  type Capability,
  type Decision,
  evaluate,
  PER_MINUTE,
  type PolicyFacts,
  type RateLimited,
} from '../../domain/policy/policy.ts'
import { freeHeld, freeSharers } from '../accounts/free-play.ts'
import {
  actionsSince,
  countServers,
  createsSince,
  emailVerified,
  loadControls,
  loadStanding,
  lockAccountActions,
  lockCapacity,
} from '../accounts/persistence.ts'
import { playToday } from '../accounts/play-today.ts'
import { playTotalLeft } from '../accounts/play-total.ts'
import { chippedInLeft, meteredMonth } from '../billing/chip-in-meter.ts'
import { extraPlayNow } from '../billing/persistence.ts'
import { type DeploymentCapabilities, supportOf } from '../capabilities.ts'
import { AppError } from '../errors.ts'
import type { CreateRoom } from '../platform/room.ts'

/** Decisions over the platform's and accounts' counts, taken under the capacity lock. */
const SPENDS: ReadonlySet<Capability['kind']> = new Set([
  'create_server',
  'start_server',
  'resize_server',
  'undelete_server',
])

/** The audit actions a rate-limited capability's use is counted by. */
const COUNTED_AS: Record<RateLimited, string> = {
  console_command: 'console.command',
  manage_access: 'access.changed',
  // One action for a star set on and taken off, with which in its data.
  star_server: 'listing.starred',
  leave_note: 'listing.note_added',
}
const rateLimited = (kind: Capability['kind']): kind is RateLimited => kind in PER_MINUTE

/** Whether an admin holds the account's free play, and why its free hours count others' play. */
async function freeFacts(
  tx: Tx,
  accountId: string,
  now: Date,
): Promise<Pick<PolicyFacts, 'freeHeld' | 'freeSharedBecause'>> {
  return {
    freeHeld: await freeHeld(tx, accountId),
    freeSharedBecause: (await freeSharers(tx, accountId, now)).why,
  }
}

/**
 * The one gate every path that spends money or exposes something publicly goes through. It must
 * run inside the transaction that performs the write; capacity decisions take a lock first.
 */
export class AccessPolicy {
  readonly #caps: DeploymentCapabilities
  /** What admits a new server beside the caps, and closes and reopens creates by itself. */
  readonly room: CreateRoom

  /** `room` knows the most servers the provider can hold, when it has a limit (§19.12). */
  constructor(caps: DeploymentCapabilities, room: CreateRoom) {
    this.#caps = caps
    this.room = room
  }

  /**
   * `lock: false` answers what the account could do without deciding anything: for pages that
   * show it, so they never queue behind the capacity lock (§15.4).
   */
  async check(
    tx: Tx,
    accountId: string,
    capability: Capability,
    now = new Date(),
    options: { lock?: boolean } = {},
  ): Promise<Decision> {
    if (SPENDS.has(capability.kind) && options.lock !== false) await lockCapacity(tx)
    // Counted and written in one transaction per account, so a burst can't slip past the count.
    const counted = rateLimited(capability.kind) ? COUNTED_AS[capability.kind] : null
    if (counted !== null && options.lock !== false) await lockAccountActions(tx, accountId)
    const standing = await loadStanding(tx, accountId)
    const extra = await extraPlayNow(tx, standing)
    const entitlements = entitlementsFor(standing.plan, standing.limitOverrides)
    const today = await playToday(tx, standing, entitlements, now)
    const month = await meteredMonth(tx, standing, entitlements, now)
    return evaluate(
      {
        deployment: supportOf(this.#caps),
        controls: await loadControls(tx),
        serverCeiling: this.room.serverCeiling,
        standing,
        emailVerified: await emailVerified(tx, accountId),
        entitlements,
        owned: await countServers(tx, accountId),
        global: await countServers(tx),
        room: await this.room.facts(tx, capability, now),
        roomRules: this.room.rules(),
        createsInLastHour: await createsSince(tx, accountId, new Date(now.getTime() - HOUR_MS)),
        unitsThisMonth: month?.units ?? 0,
        carriedThisMonth: month?.carried ?? 0,
        chippedInLeft:
          (capability.kind === 'start_server' || capability.kind === 'restart_server') &&
          capability.serverId !== undefined
            ? ((await chippedInLeft(tx, accountId, now)).get(capability.serverId) ?? 0)
            : 0,
        today: today === null ? null : { left: today.left, back: backAtMidnight(now, today.backAt) },
        totalLeft: await playTotalLeft(tx, standing, entitlements, now),
        extraUnitsAllowed: extraUnits(extra.decision),
        extraOffBecause: extra.decision.may ? null : extra.decision.why,
        extraMayRise: extra.decision.may && extra.decision.units < extra.decision.ceiling,
        owedCents: extra.owedCents,
        actionsInLastMinute:
          counted === null
            ? 0
            : await actionsSince(tx, `user:${accountId}`, counted, new Date(now.getTime() - MINUTE_MS)),
        ...(await freeFacts(tx, accountId, now)),
      },
      capability,
    )
  }

  /** `check`, turned into the refusal people see when it says no. */
  async require(tx: Tx, accountId: string, capability: Capability): Promise<void> {
    const decision = await this.check(tx, accountId, capability)
    if (!decision.ok) throw new AppError(decision.code, decision.message)
  }
}
