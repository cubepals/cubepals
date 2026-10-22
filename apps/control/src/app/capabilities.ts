// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Queryable } from '@blockly/db'
import { schema } from '@blockly/db'
import { and, count, eq, inArray } from 'drizzle-orm'
import { PAID_PLANS } from '../domain/account/entitlements.ts'
import type { GeyserMc } from './ports/geysermc.ts'
import type { Insight } from './ports/insight.ts'
import type { MalwareLists } from './ports/malware.ts'
import type { ArchiveStore, BillingProvider } from './ports/optional.ts'

/**
 * What this deployment can do. Whether a port instance exists *is* the capability, so no flag
 * can disagree with the wiring. Built once in main.ts from configuration.
 */
export interface DeploymentCapabilities {
  readonly archives: ArchiveStore | null
  readonly billing: BillingProvider | null
  /** Product analytics (PostHog): funnel events, feedback and errors. Absent sends nothing. */
  readonly insight?: Insight | null
  /**
   * The lists of known malicious jars uploads are checked against (`mods/jar-checks.ts`). Absent
   * holds them to none; their classes are still read for what operators should see.
   */
  readonly malware?: MalwareLists | null
  /**
   * What lets Bedrock players in: the key Paper servers share with the edge, and GeyserMC, where
   * Floodgate comes from and gamertags are found. Absent, no server is given Floodgate.
   */
  readonly bedrock?: { readonly floodgateKey: string; readonly geyser: GeyserMc } | null
}

export type DeploymentCapability = keyof DeploymentCapabilities

export class CapabilityUnavailable extends Error {
  readonly capability: DeploymentCapability

  constructor(capability: DeploymentCapability) {
    super(`This deployment has no ${capability} capability`)
    this.name = 'CapabilityUnavailable'
    this.capability = capability
  }
}

export function requireCapability<K extends DeploymentCapability>(
  caps: DeploymentCapabilities,
  capability: K,
): NonNullable<DeploymentCapabilities[K]> {
  const port = caps[capability]
  if (port === null) throw new CapabilityUnavailable(capability)
  return port as NonNullable<DeploymentCapabilities[K]>
}

export const supportOf = (caps: DeploymentCapabilities) => ({
  archives: caps.archives !== null,
  billing: caps.billing !== null,
  // Paid plans billing has no product for: not for sale yet, said on their card and checkout.
  unsoldPlans: caps.billing === null ? [] : PAID_PLANS.filter((plan) => !caps.billing?.sells(plan)),
})

/**
 * What the boot says when a deployment without archives still records archived data: archive
 * backups or stored artifacts, which only an archive store can hold. It lost the capability, and
 * that data can't be reached until it is back (§11, §15.4). A warning, not a failure.
 */
export async function archivesMissing(q: Queryable, caps: DeploymentCapabilities): Promise<string | null> {
  if (caps.archives !== null) return null
  const [archives] = await q
    .select({ n: count() })
    .from(schema.backups)
    .where(and(eq(schema.backups.tier, 'archive'), inArray(schema.backups.status, ['pending', 'ready'])))
  const [artifacts] = await q.select({ n: count() }).from(schema.storedArtifacts)
  const held = { archives: archives?.n ?? 0, artifacts: artifacts?.n ?? 0 }
  if (held.archives + held.artifacts === 0) return null
  return `This deployment has no archive store, but it records ${held.archives} archive backup${held.archives === 1 ? '' : 's'} and ${held.artifacts} stored mod file${held.artifacts === 1 ? '' : 's'}. It lost the archives capability: they can't be downloaded, restored or served until ARCHIVE_S3_* is set again.`
}
