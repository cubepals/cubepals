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
  lockOwnerCapacity,
} from '../accounts/persistence.ts'
import { playToday } from '../accounts/play-today.ts'
import { playTotalLeft } from '../accounts/play-total.ts'
import { chippedInLeft, meteredMonth } from '../billing/chip-in-meter.ts'
import { extraPlayNow } from '../billing/persistence.ts'
import { type DeploymentCapabilities, supportOf } from '../capabilities.ts'
import { AppError } from '../errors.ts'
import type { CreateRoom } from '../platform/room.ts'

/** Decisions over an account's counts, taken under its own capacity lock. */
const SPENDS: ReadonlySet<Capability['kind']> = new Set([
  'create_server',
  'start_server',
  'resize_server',
  'undelete_server',
])

/**
 * The spending decisions that read the platform's counts, room or caps, taken under the platform's
 * capacity lock too: a resize reads none of them.
 */
const PLATFORM_WIDE: ReadonlySet<Capability['kind']> = new Set([
  'create_server',
  'start_server',
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
 * What the decision reads of the account itself, read under the account's own locks: its standing
 * and plan, its servers and creates, its play, what it owes, and its rate-limited `counted` actions.
 */
async function accountFacts(
  tx: Tx,
  accountId: string,
  capability: Capability,
  counted: string | null,
  now: Date,
): Promise<Omit<PolicyFacts, 'deployment' | 'controls' | 'serverCeiling' | 'global' | 'room' | 'roomRules'>> {
  const standing = await loadStanding(tx, accountId)
  const extra = await extraPlayNow(tx, standing)
  const entitlements = entitlementsFor(standing.plan, standing.limitOverrides)
  const today = await playToday(tx, standing, entitlements, now)
  const month = await meteredMonth(tx, standing, entitlements, now)
  return {
    standing,
    emailVerified: await emailVerified(tx, accountId),
    entitlements,
    owned: await countServers(tx, accountId),
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
    const locks = options.lock !== false
    const { account, answers } = await this.#ownFacts(tx, accountId, capability, now, locks)
    // The platform's lock is taken last, for the few reads only it guards, and held to commit.
    if (PLATFORM_WIDE.has(capability.kind) && locks) await lockCapacity(tx)
    return evaluate({ ...account, ...(await this.#platformFacts(tx, capability, now, answers)) }, capability)
  }

  /**
   * `require` for a create, in two halves, so the create's own writes are made outside the
   * platform's lock. First it decides on everything, the platform's counts read without that lock,
   * so a create that can't go ahead is refused before anything is written. The `admit` it returns
   * is called once the server and its create are written, last before placing it: it takes the
   * platform's lock and decides again on the platform's counts, read afresh, less the server and
   * its create. Every admission still counts each one before it, since the lock is held from that
   * count to commit.
   *
   * `answers` keeps what the runtimes said about room for it, for the create's placement to read
   * under the same lock.
   */
  async requireThenAdmit(
    tx: Tx,
    accountId: string,
    capability: Extract<Capability, { kind: 'create_server' }>,
    answers: Map<string, boolean>,
  ): Promise<(serverId: string) => Promise<void>> {
    const now = new Date()
    const { account } = await this.#ownFacts(tx, accountId, capability, now, true, answers)
    refuseUnless(
      evaluate({ ...account, ...(await this.#platformFacts(tx, capability, now, answers)) }, capability),
    )
    return async (serverId) => {
      await lockCapacity(tx)
      const platform = await this.#platformFacts(tx, capability, new Date(), answers, serverId)
      // The count now holds the server this create wrote, `provisioning`: one server, one running.
      const global = { servers: platform.global.servers - 1, running: platform.global.running - 1 }
      refuseUnless(evaluate({ ...account, ...platform, global }, capability))
    }
  }

  /**
   * The account's own facts, read under its own locks, which others' decisions don't wait on; and,
   * for a create, what the runtimes say about room for it, asked before the platform's lock.
   */
  async #ownFacts(
    tx: Tx,
    accountId: string,
    capability: Capability,
    now: Date,
    locks: boolean,
    answers = new Map<string, boolean>(),
  ) {
    if (SPENDS.has(capability.kind) && locks) await lockOwnerCapacity(tx, accountId)
    // Counted and written in one transaction per account, so a burst can't slip past the count.
    const counted = rateLimited(capability.kind) ? COUNTED_AS[capability.kind] : null
    if (counted !== null && locks) await lockAccountActions(tx, accountId)
    const account = await accountFacts(tx, accountId, capability, counted, now)
    await this.room.ask(tx, capability, answers)
    return { account, answers }
  }

  /**
   * The platform's switches, counts and room: what only the platform's lock guards. `written` is a
   * server this transaction made, whose own create isn't one the room waits on.
   */
  async #platformFacts(
    tx: Tx,
    capability: Capability,
    now: Date,
    answers: Map<string, boolean>,
    written?: string,
  ) {
    return {
      deployment: supportOf(this.#caps),
      controls: await loadControls(tx),
      serverCeiling: this.room.serverCeiling,
      global: await countServers(tx),
      room: await this.room.facts(tx, capability, now, answers, written),
      roomRules: this.room.rules(),
    }
  }

  /** `check`, turned into the refusal people see when it says no. */
  async require(tx: Tx, accountId: string, capability: Capability): Promise<void> {
    refuseUnless(await this.check(tx, accountId, capability))
  }
}

function refuseUnless(decision: Decision): void {
  if (!decision.ok) throw new AppError(decision.code, decision.message)
}
