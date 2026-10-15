// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Room for new servers, as the platform finds it now: the counts `domain/policy/room.ts` decides
 * over, and the automatic switch it drives. The policy admits each create by the same counts
 * (`policy/access-policy.ts`), so a create with no room is refused before anything is written,
 * and the create page knows before anyone fills it in.
 *
 * The switch: when there is no room, creates close by themselves, for free plans first and then
 * for everyone; when room frees, they open again. A pass every minute (`creates-room`) records
 * each close and reopen in the audit log (`platform.creates_closed`, `platform.creates_reopened`)
 * and logs it. It is kept apart from the operator's own switch, `provisioningEnabled`, which
 * nothing here ever changes.
 *
 * And whether room is tight, when a free server nobody is on sleeps sooner (`idleMinutesFor`).
 *
 * It is not the create flow (`servers/service.ts`) or the caps an admin sets (`controls.ts`).
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import type { Db, Queryable } from '@blockly/db'
import { schema } from '@blockly/db'
import type { Entitlements } from '../../domain/account/entitlements.ts'
import type { Capability, NewServerRoom } from '../../domain/policy/policy.ts'
import {
  DEFAULT_ROOM,
  type FullBecause,
  fullFor,
  isTight,
  type RoomFacts,
  type RoomRules,
} from '../../domain/policy/room.ts'
import { idleMinutesNow } from '../../domain/server/idle.ts'
import { countServers, loadControls, lockCapacity } from '../accounts/persistence.ts'
import { type Actor, requestedBy } from '../actor.ts'
import type { RuntimePlacement } from '../runtimes/service.ts'
import { tuning } from '../tuning.ts'
import { type CreatesFull, loadCreatesFull, oldestWaitingCreate, saveCreatesFull } from './persistence.ts'

const ROOM: Actor = { kind: 'system', reason: 'room' }

/** Who creates are closed to, and why; null while everyone may create. */
type Closed = { for: CreatesFull['for']; because: FullBecause } | null

/** Nothing to find for anything but a create. */
const NOT_A_CREATE = { runtimes: true, queuedCreateMs: 0 }

export class CreateRoom {
  readonly #db: Db
  readonly #placement: Pick<RuntimePlacement, 'roomFor'>
  /** The most servers the runtimes can hold; null when nothing limits them. */
  readonly serverCeiling: number | null
  readonly #rules: Omit<RoomRules, 'freeShare'>

  constructor(deps: {
    db: Db
    /** Whether a runtime new servers go to could take one now. */
    placement: Pick<RuntimePlacement, 'roomFor'>
    runtime: { serverCeiling: number | null }
    /** WAKE_RESERVE and CREATE_WAIT_SECONDS, or `DEFAULT_ROOM`. */
    settings: { room?: { wakeReserve: number; createWaitSeconds: number } | undefined }
  }) {
    const room = deps.settings.room ?? DEFAULT_ROOM
    this.#db = deps.db
    this.#placement = deps.placement
    this.serverCeiling = deps.runtime.serverCeiling
    this.#rules = { wakeReserve: room.wakeReserve, createWaitMs: room.createWaitSeconds * SECOND_MS }
  }

  /** The rules in force: the deployment's reserve and wait, and the free share from its tuning. */
  rules(): RoomRules {
    return { ...this.#rules, freeShare: tuning().capacity.freeShare }
  }

  /**
   * For a create: whether a runtime could take it, where and as big as it asks when it says, and
   * how long creates already wait.
   */
  async facts(
    q: Queryable,
    capability: Capability,
    now: Date,
    answers?: Map<string, boolean>,
  ): Promise<Pick<RoomFacts, 'runtimes' | 'queuedCreateMs'>> {
    return capability.kind === 'create_server'
      ? this.#facts(q, capability.where ?? null, now, answers)
      : NOT_A_CREATE
  }

  /**
   * For a create, what the runtimes say about room for it, asked before the capacity lock: `facts`
   * under the lock decides from these answers rather than waiting on a provider there. Nothing for
   * anything else, or a create that doesn't say where it goes.
   */
  async ask(q: Queryable, capability: Capability): Promise<Map<string, boolean>> {
    const answers = new Map<string, boolean>()
    if (capability.kind === 'create_server' && capability.where !== undefined)
      await this.#placement.roomFor(q, capability.where, answers)
    return answers
  }

  async #facts(q: Queryable, where: NewServerRoom | null, now: Date, answers?: Map<string, boolean>) {
    const oldest = await oldestWaitingCreate(q)
    return {
      runtimes: await this.#placement.roomFor(q, where, answers),
      queuedCreateMs: oldest === null ? 0 : Math.max(0, now.getTime() - oldest.getTime()),
    }
  }

  /** Closes creates when there is no room and opens them when there is, recording each change. */
  async settle(now = new Date()): Promise<'closed' | 'reopened' | null> {
    const room: RoomFacts = {
      controls: await loadControls(this.#db),
      serverCeiling: this.serverCeiling,
      global: await countServers(this.#db),
      ...(await this.#facts(this.#db, null, now)),
    }
    const rules = this.rules()
    const everyone = fullFor(room, rules, true)
    const free = fullFor(room, rules, false)
    const next: Closed =
      everyone !== null
        ? { for: 'everyone', because: everyone }
        : free === null
          ? null
          : { for: 'free', because: free }
    const changed = await this.#db.transaction(async (tx) => {
      await lockCapacity(tx)
      const was = await loadCreatesFull(tx)
      if (was?.for === next?.for && was?.because === next?.because) return null
      // Open to more people than before, everyone or paid plans again, is a reopening.
      const reopened = next === null || (was?.for === 'everyone' && next.for === 'free')
      await saveCreatesFull(tx, next === null ? null : { ...next, since: was?.since ?? now })
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(ROOM),
        action: reopened ? 'platform.creates_reopened' : 'platform.creates_closed',
        subjectType: 'platform',
        subjectId: 'creates',
        data: {
          was: was === null ? null : { for: was.for, because: was.because },
          now: next,
          ...room.global,
        },
      })
      return reopened ? 'reopened' : 'closed'
    })
    const to = next === null ? 'everyone' : next.for === 'free' ? 'paid plans' : 'nobody'
    if (changed !== null)
      console.warn(
        `room: creates ${changed}, open to ${to}${next === null ? '' : ` (${next.because})`}, ${room.global.running} running`,
      )
    return changed
  }
}

/**
 * The idle time an empty server on `plan` gets now: the plan's, shortened for a free one while
 * running room is tight (`idleMinutesNow`). The idle check stops servers by it, and the server
 * page says when they sleep by it, so the two agree.
 */
export async function idleMinutesFor(q: Queryable, plan: Entitlements): Promise<number | null> {
  const { tightShare, tightIdleMinutes } = tuning().capacity
  const free = plan.monthlyPriceCents === 0
  const tight =
    free && isTight({ controls: await loadControls(q), global: await countServers(q) }, tightShare)
  return idleMinutesNow(plan.idleShutdownAfterMinutes, { free, tight, tightMinutes: tightIdleMinutes })
}
