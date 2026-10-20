// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * cubepals.com as the Cloudflare Worker `blockly-web`: production's values for lib/web-worker.ts,
 * which builds the Worker from this checkout, checks the build and deploys it, and the way back to
 * the version that was live before. The values are the ones the rest of production is made from:
 * config.auto.tfvars.json's settings, the control app the stack names, and production.env.
 *
 * Terraform owns the Worker's settings, its cache bucket and its routes (infra/terraform/modules/web);
 * the code, vars and secret arrive with each deploy, which is live when it returns. A rollback puts
 * an earlier version back at once, without a build. A deploy asks cubepals.com for its pages and, if
 * they don't answer, rolls itself back (deployChecked).
 */
import { ask, describe, PRODUCTION_OTHERS, SITE_PAGES, waitFor, websiteTargets } from './lib/site-pages.ts'
import { deployWorker, liveVersions, rollbackWorker, type WorkerSite } from './lib/web-worker.ts'
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
    beta: environment.web.beta !== false,
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

/** The site's address, as signInGuard asks it too. */
const PRODUCTION_ORIGIN = 'https://cubepals.com'

/** How long a new version has to answer, while Cloudflare moves traffic to it, and a rolled-back one. */
const DEPLOY_SECONDS = 180
const ROLLBACK_SECONDS = 60

/**
 * The last build deployed, then cubepals.com asked for its pages for up to three minutes. If they
 * still fail, the version that was live before the deploy is put back (wrangler rollback), asked
 * again, and the deploy fails, whatever the second ask finds. A Worker that deploys can still throw
 * on every request (2026-10-19: Cloudflare error 1101 for an hour and a half).
 */
export async function deployChecked(
  site: WorkerSite,
  sha: string,
  say: (line: string) => void,
): Promise<void> {
  const [before] = liveVersions(site)
  deployWorker(site, sha, say)
  const origin = PRODUCTION_ORIGIN
  say(`Asking ${origin} for ${SITE_PAGES.join(', ')}.`)
  if ((await waitFor(websiteTargets(origin), DEPLOY_SECONDS, say)).failing.length === 0) {
    // The other public addresses aren't this Worker's: said, never a reason to roll back.
    const others = await ask(PRODUCTION_OTHERS)
    say(`The other public addresses: ${others.map(describe).join(', ')}.`)
    return
  }
  if (before === undefined)
    throw new Error(`${origin} doesn't answer, and there is no earlier version to go back to.`)
  say(`${origin} doesn't answer on ${sha.slice(0, 8)}; putting back the version live before it.`)
  rollbackWorker(site, before, say)
  const after = await waitFor(websiteTargets(origin), ROLLBACK_SECONDS, say)
  throw new Error(
    `${sha.slice(0, 8)} left ${origin} failing and was rolled back to ${before.commit?.slice(0, 8) ?? before.version}; ` +
      (after.failing.length === 0 ? 'the site answers again.' : 'THE SITE STILL DOES NOT ANSWER.'),
  )
}
