import { createHash } from 'node:crypto'
import type { RuntimeConsideredJson } from '@blockly/db'
import type { Placement } from '../ports/runtime.ts'

/**
 * Which runtime a new server goes to (docs/runtimes.md), as one explicit policy rather than
 * branches through the application: the deployment's default runtime, unless an operator's rule
 * sends it elsewhere. A rule matches owners, regions and plans, and takes a share of what matches;
 * the first rule that matches, whose runtime this deployment runs and has room for the server,
 * places it. Nothing else is weighed yet: no prices, no optimiser.
 *
 * It decides once, when a server is made. A server stays on the runtime it was placed on until an
 * operator moves it; turning a rule off only changes where new servers go.
 */

export interface PlacementRule {
  id: string
  provider: string
  enabled: boolean
  /** The share of matching new servers it sends, 0 to 100. */
  percent: number
  /** Empty lists match everything. */
  accounts: readonly string[]
  regions: readonly string[]
  plans: readonly string[]
  note: string
}

export interface NewServer {
  serverId: string
  ownerId: string
  plan: string
  regionKey: string
  memoryMb: number
  storageGb: number
}

/** What placement needs to know about the runtimes a deployment runs. */
export interface PlacementTargets {
  /** Where every server goes that no rule sends elsewhere. */
  defaultProvider: string
  /** Every runtime the deployment runs, in the order configured: where a full default overflows. */
  providers: readonly string[]
  runs(provider: string): boolean
  /** Holding as many servers as its provider allows (`MinecraftRuntime.serverCeiling`). */
  atLimit(provider: string): boolean
  hasRoom(
    provider: string,
    placement: Placement,
    size: { memoryMb: number; storageGb: number },
  ): Promise<boolean>
}

export interface Placed {
  provider: string
  /**
   * The rule that sent it, recorded with the decision: only a server a rule sent elsewhere falls
   * back to the default when its runtime has no room at its first start (`fallbackFor`).
   */
  ruleId: string | null
  reason: string
  considered: RuntimeConsideredJson[]
}

/**
 * A server's place in a rule's rollout, in [0, 100): the same server always gets the same number
 * under the same rule, so a share grows by adding servers, never by moving the ones already in.
 */
export function rolloutBucket(ruleId: string, serverId: string): number {
  const digest = createHash('sha256').update(`${ruleId}:${serverId}`).digest()
  return (digest.readUInt32BE(0) % 10_000) / 100
}

const listed = (list: readonly string[], value: string) => list.length === 0 || list.includes(value)

export async function decidePlacement(
  server: NewServer,
  rules: readonly PlacementRule[],
  targets: PlacementTargets,
): Promise<Placed> {
  const considered: RuntimeConsideredJson[] = []
  const placement = { regionKey: server.regionKey }
  const size = { memoryMb: server.memoryMb, storageGb: server.storageGb }
  for (const rule of rules) {
    if (!rule.enabled) continue
    const seen = (outcome: RuntimeConsideredJson['outcome'], detail: string) =>
      considered.push({ provider: rule.provider, ruleId: rule.id, outcome, detail })
    if (!targets.runs(rule.provider)) {
      seen('not_run', 'this deployment does not run it')
      continue
    }
    if (!listed(rule.accounts, server.ownerId)) {
      seen('not_matched', 'its owner is not on the rule')
      continue
    }
    if (!listed(rule.regions, server.regionKey)) {
      seen('not_matched', `the rule does not cover ${server.regionKey}`)
      continue
    }
    if (!listed(rule.plans, server.plan)) {
      seen('not_matched', `the rule does not cover the ${server.plan} plan`)
      continue
    }
    const bucket = rolloutBucket(rule.id, server.serverId)
    if (bucket >= rule.percent) {
      seen('not_in_rollout', `${bucket.toFixed(2)} is outside the rule's ${rule.percent}%`)
      continue
    }
    if (targets.atLimit(rule.provider)) {
      seen('no_room', 'it holds as many servers as its provider allows')
      continue
    }
    if (!(await targets.hasRoom(rule.provider, placement, size))) {
      seen('no_room', `no room for ${server.memoryMb} MB in ${server.regionKey}`)
      continue
    }
    seen('chosen', rule.note === '' ? 'matched the rule' : `matched the rule: ${rule.note}`)
    return {
      provider: rule.provider,
      ruleId: rule.id,
      reason: `rule ${rule.id.slice(0, 8)} (${rule.percent}%)`,
      considered,
    }
  }
  // The default at its provider's limit overflows to the first other runtime with room: a server
  // placed where it can't be held would only wait.
  if (targets.atLimit(targets.defaultProvider)) {
    considered.push({
      provider: targets.defaultProvider,
      ruleId: null,
      outcome: 'no_room',
      detail: 'the default runtime holds as many servers as its provider allows',
    })
    for (const provider of targets.providers) {
      if (provider === targets.defaultProvider || targets.atLimit(provider)) continue
      if (!(await targets.hasRoom(provider, placement, size))) {
        considered.push({ provider, ruleId: null, outcome: 'no_room', detail: 'no room to overflow to' })
        continue
      }
      considered.push({ provider, ruleId: null, outcome: 'chosen', detail: 'the default runtime was full' })
      return {
        provider,
        ruleId: null,
        reason: `overflow: ${targets.defaultProvider} is at its provider's limit`,
        considered,
      }
    }
  }
  const full = considered.filter((c) => c.outcome === 'no_room').map((c) => c.provider)
  considered.push({
    provider: targets.defaultProvider,
    ruleId: null,
    outcome: 'chosen',
    detail: 'the default runtime',
  })
  return {
    provider: targets.defaultProvider,
    ruleId: null,
    reason:
      full.length === 0
        ? 'the default runtime'
        : `the default runtime: ${[...new Set(full)].join(', ')} had no room`,
    considered,
  }
}
