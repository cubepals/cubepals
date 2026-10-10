/**
 * cubepals.com as the Cloudflare Worker `blockly-web`: production's values for lib/web-worker.ts,
 * which builds the Worker from this checkout, checks the build and deploys it, and the way back to
 * the version that was live before. The values are the ones the rest of production is made from:
 * config.auto.tfvars.json's settings, the control app the stack names, and production.env.
 *
 * Terraform owns the Worker's settings, its cache bucket and its routes (infra/terraform/modules/web);
 * the code, vars and secret arrive with each deploy, which is live when it returns. A rollback puts
 * an earlier version back at once, without a build.
 */
import { liveVersions, rollbackWorker, type WorkerSite } from './lib/web-worker.ts'
import type { Environment } from './production-values.ts'

/** Production's website, from production.env's values and the environment's settings. */
export function productionSite(values: Record<string, string>, environment: Environment): WorkerSite {
  const { settings } = environment
  const sourceMaps =
    values.POSTHOG_PERSONAL_API_KEY && values.POSTHOG_PROJECT_ID
      ? { key: values.POSTHOG_PERSONAL_API_KEY, project: values.POSTHOG_PROJECT_ID }
      : undefined
  return {
    // The control app modules/fly-org names, at its fly.dev address, as the stack's api_origin.
    apiUpstream: `https://bly-${settings.DEPLOYMENT_ID}-control.fly.dev`,
    canonicalOrigin: settings.WEB_CANONICAL_ORIGIN ?? '',
    deploymentId: settings.DEPLOYMENT_ID ?? '',
    indexable: environment.web.indexable === true,
    proxySecret: values.WEB_PROXY_SECRET ?? '',
    posthogToken: settings.POSTHOG_TOKEN || undefined,
    sourceMaps,
    cloudflare: {
      token: values.CLOUDFLARE_WORKERS_API_TOKEN ?? '',
      accountId: values.CLOUDFLARE_ACCOUNT_ID ?? '',
    },
  }
}

/** cubepals.com back on the version that was live before this one; false when there is none. */
export function rollbackWebsite(site: WorkerSite, say: (line: string) => void): boolean {
  const [, previous] = liveVersions(site)
  if (previous === undefined) return false
  rollbackWorker(site, previous, say)
  return true
}
