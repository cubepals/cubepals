// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Db, schema, type Tx } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { PLAN_KEYS } from '../../domain/account/entitlements.ts'
import { AppError, NotFound } from '../errors.ts'
import type { RegionCatalog } from '../ports/platform.ts'
import { findServer, loadRuntime } from '../servers/persistence.ts'
import {
  computeByProvider,
  decisionsOf,
  insertRule,
  loadRule,
  loadRules,
  pendingMoves,
  placedDecision,
  type RuntimeDecision,
  recentDecisions,
  recordDecision,
  type StoredRule,
  serversByProvider,
  setMoveTo,
  updateRule,
  usersByEmail,
} from './persistence.ts'
import { decidePlacement, type NewServer, type Placed, type PlacementRule } from './placement.ts'
import type { Runtimes } from './router.ts'

/** A rule as an operator writes it: owners by email or id. */
export interface RuleInput {
  provider: string
  percent: number
  accounts?: readonly string[]
  regions?: readonly string[]
  plans?: readonly string[]
  note?: string
  enabled?: boolean
}

export type RulePatch = Partial<Omit<RuleInput, 'provider'>>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Which runtime each server is on, as operators steer it (docs/runtimes.md): the placement of new
 * servers by the rules, the fallback when a rule's runtime had no room, and moves an operator asks
 * for. Every decision is recorded with what was considered, so where a server runs is explained
 * in one place. Owners are never asked any of it: where their server runs is Blockly's to decide.
 */
export class RuntimePlacement {
  readonly #db: Db
  readonly #runtimes: Runtimes
  readonly #regions: RegionCatalog
  readonly #archives: boolean
  /** Where every new server goes that no rule sends elsewhere. */
  readonly defaultProvider: string

  constructor(deps: {
    db: Db
    runtimes: Runtimes
    regions: RegionCatalog
    defaultProvider: string
    /** Moves go through the archive store: without one, servers stay where they were placed. */
    archives: boolean
  }) {
    if (!deps.runtimes.runs(deps.defaultProvider))
      throw new Error(`The default runtime ${deps.defaultProvider} is not one this deployment runs`)
    this.#db = deps.db
    this.#runtimes = deps.runtimes
    this.#regions = deps.regions
    this.#archives = deps.archives
    this.defaultProvider = deps.defaultProvider
  }

  /** Where a new server goes, decided once and recorded in the transaction that makes it. */
  async place(tx: Tx, server: NewServer, by: string): Promise<Placed> {
    // A runtime whose provider caps the servers it holds (Fly's machine limit) is full at its cap:
    // the deployment's own cap can't see that once another runtime has none. Only servers holding
    // compute there count against it.
    const held = await computeByProvider(tx)
    const placed = await decidePlacement(server, await loadRules(tx), {
      defaultProvider: this.defaultProvider,
      providers: this.#runtimes.providers,
      runs: (provider) => this.#runtimes.runs(provider),
      atLimit: (provider) => {
        const ceiling = this.#runtimes.runs(provider) ? this.#runtimes.ceilingOf(provider) : null
        return ceiling !== null && (held.get(provider) ?? 0) >= ceiling
      },
      hasRoom: (provider, placement, size) =>
        this.#runtimes.hasRoom(provider, placement, size).catch(() => false),
    })
    await recordDecision(tx, {
      serverId: server.serverId,
      kind: 'placed',
      provider: placed.provider,
      fromProvider: null,
      ruleId: placed.ruleId,
      reason: placed.reason,
      considered: placed.considered,
      decidedBy: by,
    })
    return placed
  }

  /**
   * Where a server goes when its runtime has no room at its first start (the explicit fallback):
   * the default runtime, for one a rule sent elsewhere, as its placement records. Nowhere for one
   * on the default, or sent elsewhere because the default was full (overflow): it waits for room,
   * as every server always has.
   */
  async fallbackFor(serverId: string, provider: string): Promise<string | null> {
    if (provider === this.defaultProvider) return null
    const placed = await placedDecision(this.#db, serverId)
    return placed === null || placed.ruleId === null ? null : this.defaultProvider
  }

  async fellBack(tx: Tx, serverId: string, from: string, to: string, reason: string): Promise<void> {
    await recordDecision(tx, {
      serverId,
      kind: 'fell_back',
      provider: to,
      fromProvider: from,
      ruleId: null,
      reason,
      considered: [],
      decidedBy: 'system:placement',
    })
  }

  async moveEnded(
    q: Tx | Db,
    serverId: string,
    outcome: { moved: boolean; from: string; to: string; reason: string },
  ): Promise<void> {
    await recordDecision(q, {
      serverId,
      kind: outcome.moved ? 'moved' : 'move_failed',
      provider: outcome.moved ? outcome.to : outcome.from,
      fromProvider: outcome.moved ? outcome.from : null,
      ruleId: null,
      reason: outcome.reason,
      considered: [],
      decidedBy: 'system:relocate',
    })
  }

  // ─── What operators ask ────────────────────────────────────────────────────────────────────

  async rules(): Promise<StoredRule[]> {
    return loadRules(this.#db)
  }

  async addRule(input: RuleInput, by: string): Promise<StoredRule> {
    if (!this.#runtimes.runs(input.provider))
      throw new AppError(
        'invalid_choice',
        `This deployment runs ${this.#runtimes.providers.join(', ')}, not ${input.provider}.`,
      )
    const rule: Omit<PlacementRule, 'id'> = {
      provider: input.provider,
      enabled: input.enabled ?? true,
      percent: this.#percent(input.percent),
      accounts: await this.#accounts(input.accounts ?? []),
      regions: this.#regionKeys(input.regions ?? []),
      plans: this.#plans(input.plans ?? []),
      note: input.note ?? '',
    }
    return this.#db.transaction(async (tx) => {
      const saved = await insertRule(tx, rule, by)
      await audit(tx, by, 'runtime_rule.created', saved.id, { ...rule })
      return saved
    })
  }

  async changeRule(id: string, patch: RulePatch, by: string): Promise<StoredRule> {
    if (!UUID.test(id)) throw new NotFound('Rule')
    const change: Partial<Omit<PlacementRule, 'id' | 'provider'>> = {
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.percent === undefined ? {} : { percent: this.#percent(patch.percent) }),
      ...(patch.accounts === undefined ? {} : { accounts: await this.#accounts(patch.accounts) }),
      ...(patch.regions === undefined ? {} : { regions: this.#regionKeys(patch.regions) }),
      ...(patch.plans === undefined ? {} : { plans: this.#plans(patch.plans) }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
    }
    return this.#db.transaction(async (tx) => {
      const before = await loadRule(tx, id)
      if (before === null) throw new NotFound('Rule')
      const saved = await updateRule(tx, id, change, by)
      if (saved === null) throw new NotFound('Rule')
      await audit(tx, by, 'runtime_rule.changed', id, { before: ruleData(before), after: ruleData(saved) })
      return saved
    })
  }

  /**
   * An operator's move of an existing server to another runtime. It happens at the server's next
   * quiet moment, through the archive store, by the application's own relocation: never because a
   * rule changed, and never on its own for a cheaper place.
   */
  async requestMove(serverId: string, to: string, by: string): Promise<void> {
    if (!this.#runtimes.runs(to))
      throw new AppError(
        'invalid_choice',
        `This deployment runs ${this.#runtimes.providers.join(', ')}, not ${to}.`,
      )
    if (!this.#archives)
      throw new AppError(
        'invalid_choice',
        'Servers move between runtimes through the archive store, and this deployment keeps none.',
      )
    if (!UUID.test(serverId)) throw new NotFound('Server')
    await this.#db.transaction(async (tx) => {
      const server = await findServer(tx, serverId)
      if (server === null || server.deletedAt !== null) throw new NotFound('Server')
      const binding = await loadRuntime(tx, serverId, this.#runtimes.providers)
      if (binding.provider === to) {
        if (binding.moveTo !== null) await setMoveTo(tx, serverId, null)
        throw new AppError('invalid_choice', `It is on ${to} already.`)
      }
      if (binding.foreign)
        throw new AppError(
          'invalid_choice',
          `It is on ${binding.provider}, which this deployment doesn't run, so it can't be reached to move.`,
        )
      await setMoveTo(tx, serverId, to)
      await recordDecision(tx, {
        serverId,
        kind: 'move_requested',
        provider: to,
        fromProvider: binding.provider,
        ruleId: null,
        reason: 'an operator asked for it',
        considered: [],
        decidedBy: by,
      })
    })
  }

  async cancelMove(serverId: string, by: string): Promise<void> {
    if (!UUID.test(serverId)) throw new NotFound('Server')
    await this.#db.transaction(async (tx) => {
      const binding = await loadRuntime(tx, serverId, this.#runtimes.providers).catch(() => null)
      if (binding === null) throw new NotFound('Server')
      if (binding.moveTo === null) return
      await setMoveTo(tx, serverId, null)
      await recordDecision(tx, {
        serverId,
        kind: 'move_cancelled',
        provider: binding.provider,
        fromProvider: null,
        ruleId: null,
        reason: `the move to ${binding.moveTo} was called off`,
        considered: [],
        decidedBy: by,
      })
    })
  }

  /** Where a server is, where it is going, and every decision about it. */
  async where(serverId: string): Promise<{
    provider: string
    runs: boolean
    moveTo: string | null
    decisions: RuntimeDecision[]
  }> {
    if (!UUID.test(serverId)) throw new NotFound('Server')
    const binding = await loadRuntime(this.#db, serverId, this.#runtimes.providers).catch(() => null)
    if (binding === null) throw new NotFound('Server')
    return {
      provider: binding.provider,
      runs: !binding.foreign,
      moveTo: binding.moveTo,
      decisions: await decisionsOf(this.#db, serverId),
    }
  }

  async summary(since: Date): Promise<{
    defaultProvider: string
    providers: Array<{ provider: string; servers: number; ceiling: number | null }>
    rules: StoredRule[]
    pendingMoves: Array<{ serverId: string; from: string; to: string }>
    decisions: RuntimeDecision[]
  }> {
    const counts = await serversByProvider(this.#db)
    const known = new Set([...this.#runtimes.providers, ...counts.keys()])
    return {
      defaultProvider: this.defaultProvider,
      providers: [...known].map((provider) => ({
        provider,
        servers: counts.get(provider) ?? 0,
        ceiling: this.#runtimes.runs(provider) ? this.#runtimes.ceilingOf(provider) : null,
      })),
      rules: await loadRules(this.#db),
      pendingMoves: await pendingMoves(this.#db),
      decisions: await recentDecisions(this.#db, since),
    }
  }

  #percent(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 100)
      throw new AppError('invalid_choice', 'A rule sends a whole percentage, from 0 to 100.')
    return value
  }

  #regionKeys(keys: readonly string[]): string[] {
    for (const key of keys)
      if (this.#regions.label(key) === null)
        throw new AppError(
          'invalid_choice',
          `There is no region ${key}; there are ${this.#regions
            .list()
            .map((r) => r.key)
            .join(', ')}.`,
        )
    return [...new Set(keys)]
  }

  #plans(plans: readonly string[]): string[] {
    for (const plan of plans)
      if (!PLAN_KEYS.includes(plan))
        throw new AppError('invalid_choice', `There is no ${plan} plan; there are ${PLAN_KEYS.join(', ')}.`)
    return [...new Set(plans)]
  }

  /** Accounts by id or email; one that names nobody is refused rather than matching nobody. */
  async #accounts(given: readonly string[]): Promise<string[]> {
    const emails = given.filter((value) => !UUID.test(value))
    const found = await usersByEmail(this.#db, emails)
    const ids: string[] = []
    for (const value of given) {
      if (UUID.test(value)) {
        const [user] = await this.#db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.id, value))
        if (!user) throw new AppError('invalid_choice', `There is no account ${value}.`)
        ids.push(value)
      } else {
        const id = found.get(value.toLowerCase())
        if (id === undefined) throw new AppError('invalid_choice', `There is no account for ${value}.`)
        ids.push(id)
      }
    }
    return [...new Set(ids)]
  }
}

const ruleData = (rule: PlacementRule) => ({
  provider: rule.provider,
  enabled: rule.enabled,
  percent: rule.percent,
  accounts: rule.accounts,
  regions: rule.regions,
  plans: rule.plans,
  note: rule.note,
})

async function audit(
  tx: Tx,
  actor: string,
  action: string,
  subjectId: string,
  data: Record<string, unknown>,
) {
  await tx.insert(schema.auditLog).values({ actor, action, subjectType: 'runtime_rule', subjectId, data })
}
