// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Queryable } from '@blockly/db'
import { schema } from '@blockly/db'
import { and, count, eq, inArray } from 'drizzle-orm'
import type { Insight } from './ports/insight.ts'
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
