import type { Tx } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import {
  type Capability,
  type Decision,
  evaluate,
  PER_MINUTE,
  type RateLimited,
} from '../../domain/policy/policy.ts'
import {
  actionsSince,
  countServers,
  createsSince,
  emailVerified,
  loadControls,
  loadStanding,
  lockAccountActions,
  lockCapacity,
  runUnitsSince,
} from '../accounts/persistence.ts'
import { type DeploymentCapabilities, supportOf } from '../capabilities.ts'
import { AppError } from '../errors.ts'

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

/**
 * The one gate every path that spends money or exposes something publicly goes through. It must
 * run inside the transaction that performs the write; capacity decisions take a lock first.
 */
export class AccessPolicy {
  readonly #caps: DeploymentCapabilities
  readonly #serverCeiling: number | null

  /** `serverCeiling`: the most servers the provider can hold, when it has a limit (§19.12). */
  constructor(caps: DeploymentCapabilities, serverCeiling: number | null = null) {
    this.#caps = caps
    this.#serverCeiling = serverCeiling
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
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    return evaluate(
      {
        deployment: supportOf(this.#caps),
        controls: await loadControls(tx),
        serverCeiling: this.#serverCeiling,
        standing,
        emailVerified: await emailVerified(tx, accountId),
        entitlements: entitlementsFor(standing.plan, standing.limitOverrides),
        owned: await countServers(tx, accountId),
        global: await countServers(tx),
        createsInLastHour: await createsSince(tx, accountId, new Date(now.getTime() - 3_600_000)),
        unitsThisMonth: await runUnitsSince(tx, accountId, monthStart, now),
        extraUnitsAllowed: standing.extraUnitsAllowed,
        actionsInLastMinute:
          counted === null
            ? 0
            : await actionsSince(tx, `user:${accountId}`, counted, new Date(now.getTime() - 60_000)),
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
