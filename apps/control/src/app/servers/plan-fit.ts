// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** How a plan judges what the create page offers: allowed or dimmed, with why and the plan that runs it. */
import type { CreateOptions, PlanFit } from '@blockly/contracts'
import {
  addedLabel,
  comesWith,
  type Entitlements,
  planGap,
  planName,
  planThatRuns,
  type Runs,
} from '../../domain/account/entitlements.ts'
import { PARTY, type PartySize } from '../../domain/server/size.ts'
import { LOADER_LABELS } from '../../minecraft/versions.ts'

const PARTY_LABELS: Record<PartySize, string> = {
  '5': 'Up to 5',
  '10': 'Up to 10',
  '20': 'Up to 20',
  '50': 'Up to 50',
  more: 'Up to 100',
}

/**
 * Who's playing, as a plan judges it: a group the plan's sizes don't hold comes with the plan that
 * does, said as the group ("Groups over 5 come with Plus"), never as a size.
 */
export function partySizesFor(plan: Entitlements): CreateOptions['partySizes'] {
  const sizes = Object.keys(PARTY) as PartySize[]
  const largest = Math.max(
    0,
    ...sizes
      .filter((size) => plan.allowedMemoryTiers.includes(PARTY[size].tier))
      .map((size) => PARTY[size].maxPlayers),
  )
  return sizes.map((value) => {
    const runs = { tier: PARTY[value].tier, loader: 'vanilla' as const, modded: false }
    const allowed = planGap(plan, runs, 'offered') === null
    const paid = allowed ? null : planThatRuns(runs)
    return {
      value,
      label: PARTY_LABELS[value],
      maxPlayers: PARTY[value].maxPlayers,
      allowed,
      ...(allowed ? {} : { reason: comesWith(`Groups over ${largest}`, paid), plan: paid }),
    }
  })
}

/** What a plan runs before what it doesn't, each in the order it came (the sort is stable). */
export function usableFirst<T extends { fits: { allowed: boolean } }>(items: T[]): T[] {
  return [...items].sort((a, b) => Number(b.fits.allowed) - Number(a.fits.allowed))
}

/**
 * Whether a plan runs something, and if not, why, and which plan would. A refusal and a dimmed
 * choice both come from `planGap`, the rule creating is checked by, so the page never offers
 * what the create would refuse, nor words it differently. In the owner's terms, not the
 * machine's: what they want to know is whether they can play it, and a size in gigabytes is
 * Blockly's problem (§15.6).
 */
export function planFit(plan: Entitlements, what: string, runs: Runs & { modpack?: boolean }): PlanFit {
  const gap = planGap(plan, runs, 'offered')
  if (gap === null) return { allowed: true }
  const paid = planThatRuns(runs)
  const comes = paid === null ? 'need a paid plan' : `come with ${planName(paid)}`
  const reason =
    gap === 'mods' || gap === 'datapacks'
      ? comesWith(addedLabel(gap, runs.modpack === true), paid)
      : gap === 'server_type'
        ? `${LOADER_LABELS[runs.loader]} servers ${comes}.`
        : `${what} needs a bigger server${paid === null ? '' : `, which comes with ${planName(paid)}`}.`
  return { allowed: false, reason, plan: paid }
}
