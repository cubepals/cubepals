// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The deployment's optional capabilities, made from its configuration as the process starts:
 * analytics, the malware lists, Bedrock, play records, archives and billing
 * (`app/capabilities.ts` says what each one is). Not for: wiring them into the control plane
 * (`main.node.ts`).
 */
import type { Db } from '@blockly/db'
import type { DeploymentCapabilities } from '../app/capabilities.ts'
import type { DeploymentConfig } from '../config/schema.ts'
import { entitlementsFor, PAID_PLANS } from '../domain/account/entitlements.ts'
import { playRecordsFor } from '../infra/cloudflare/dns-records.ts'
import { bedrockCapability } from '../infra/geysermc/geysermc.ts'
import { LocalBilling } from '../infra/local-billing/local-billing.ts'
import { PublishedMalwareLists } from '../infra/malware/mcantimalware.ts'
import { PolarBilling } from '../infra/polar/polar-billing.ts'
import { PostHogInsight } from '../infra/posthog/posthog-insight.ts'
import { S3ArchiveStore } from '../infra/s3/s3-archive-store.ts'

export function capabilitiesFor(config: DeploymentConfig, db: Db): DeploymentCapabilities {
  const billing = config.billing
  return {
    insight: insightFor(config),
    malware: new PublishedMalwareLists(),
    bedrock: bedrockCapability(config.floodgateKey),
    playRecords: playRecordsFor(config.play, config.deploymentId),
    archives: config.archive === null ? null : new S3ArchiveStore(config.archive),
    billing:
      billing?.provider === 'polar'
        ? new PolarBilling(billing)
        : billing?.provider === 'local'
          ? new LocalBilling({
              db,
              secret: config.auth.secret,
              webOrigin: config.web.canonicalOrigin,
              // A month of each paid plan at its price, as Polar's gift products would sell it.
              gifts: PAID_PLANS.map((planKey) => ({
                id: `local-gift-${planKey}`,
                planKey,
                months: 1,
                priceCents: entitlementsFor(planKey).monthlyPriceCents,
              })),
            })
          : null,
  }
}

/**
 * PostHog when a token is set (app/ports/insight.ts); none sends nothing. What nothing caught,
 * unhandled rejections included, still ends the process as before: the monitor only reports it on
 * the way, as far as the queue gets before the exit.
 */
function insightFor(config: DeploymentConfig): PostHogInsight | null {
  if (config.insight === null) return null
  const insight = new PostHogInsight(config.insight)
  process.on('uncaughtExceptionMonitor', (error, origin) =>
    insight.exception(error, { properties: { route: 'process', origin } }),
  )
  return insight
}
