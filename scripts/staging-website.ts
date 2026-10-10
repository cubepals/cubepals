// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * staging.cubepals.com as the Cloudflare Worker `blockly-web-staging`: staging's values for
 * lib/web-worker.ts, and the two ways a commit reaches the Worker without the rest of staging.
 *
 *   bun scripts/staging-website.ts deploy        this checkout, built with staging's values and live
 *   bun scripts/staging-website.ts preview <n>   this checkout as pull request <n>'s preview version,
 *                                                at pr-<n>-blockly-web-staging.<subdomain>.workers.dev
 *
 * The web-staging workflow runs both: deploy on each push to main, preview on each pull request
 * from this repository. `staging.ts up` deploys the Worker with the rest of staging, from
 * stagingSite, and tells staging's control plane to trust the previews' addresses (previewOrigins).
 *
 * Neither command touches the control plane or the Worker's WEB_PROXY_SECRET: a version keeps the
 * secret `up` gave the Worker. CLOUDFLARE_WORKERS_API_TOKEN uploads it, to the account
 * CLOUDFLARE_ACCOUNT_ID names, or else the one holding cubepals.com, which CLOUDFLARE_API_TOKEN
 * (DNS) can look up. Nothing here prints a value. A preview's address goes to GITHUB_OUTPUT as
 * `url` when there is one.
 */
import { appendFileSync } from 'node:fs'
import { zoneAccount } from './lib/cloudflare-dns.ts'
import { buildWorker, deployWorker, uploadPreview, type WorkerSite } from './lib/web-worker.ts'

/** As staging.ts names them: the control app on fly.dev, and the site's one address. */
const API = 'https://bly-staging-control.fly.dev'
const WEB = 'https://staging.cubepals.com'
/** wrangler.jsonc's `staging` environment. */
const WORKER = 'blockly-web-staging'

type Cloudflare = WorkerSite['cloudflare']

const say = (line: string) => process.stdout.write(`${line}\n`)

/** The Workers token and the account it uploads to, from the environment. */
export async function stagingCloudflare(): Promise<Cloudflare> {
  const token = process.env.CLOUDFLARE_WORKERS_API_TOKEN
  if (!token)
    throw new Error('CLOUDFLARE_WORKERS_API_TOKEN (Workers and R2 on cubepals.com’s account) is not set')
  const dns = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (dns ? await zoneAccount(dns, 'cubepals.com') : '')
  if (!accountId) throw new Error('Neither CLOUDFLARE_ACCOUNT_ID nor CLOUDFLARE_API_TOKEN (DNS) is set')
  return { token, accountId }
}

/**
 * Staging's website: the /api rewrite to staging's control plane, noindex, and, given the secret,
 * its word about each browser's address, which the control plane believes only with it.
 */
export function stagingSite(cloudflare: Cloudflare, proxySecret?: string): WorkerSite {
  return {
    env: 'staging',
    apiUpstream: API,
    canonicalOrigin: WEB,
    deploymentId: 'staging',
    indexable: false,
    proxySecret,
    cloudflare,
  }
}

/** The pattern every pull request's preview address matches, under the account's workers.dev subdomain. */
export const previewPattern = (subdomain: string) => `https://pr-*-${WORKER}.${subdomain}.workers.dev`

/** WEB_TRUSTED_ORIGINS for staging's control plane: the previews, on the account's own subdomain. */
export async function previewOrigins(cloudflare: Cloudflare): Promise<string> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cloudflare.accountId}/workers/subdomain`,
    { headers: { authorization: `Bearer ${cloudflare.token}` } },
  )
  const answer = (await response.json()) as { success: boolean; result?: { subdomain?: string } }
  const subdomain = answer.result?.subdomain
  if (!answer.success || !subdomain)
    throw new Error('Cloudflare named no workers.dev subdomain for the account')
  return previewPattern(subdomain)
}

const head = () => Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim()

async function deploy(): Promise<void> {
  const site = stagingSite(await stagingCloudflare())
  const sha = head()
  buildWorker(site, sha, say)
  deployWorker(site, sha, say)
}

async function preview(pull: string | undefined): Promise<void> {
  if (!pull || !/^[1-9]\d*$/.test(pull)) throw new Error('Name the pull request by its number')
  const site = stagingSite(await stagingCloudflare())
  const sha = head()
  buildWorker(site, sha, say)
  const url = uploadPreview(site, sha, `pr-${pull}`)
  if (url === undefined) {
    say(
      `Uploaded, but ${WORKER} has preview URLs off: a deploy with wrangler.jsonc's preview_urls turns them on.`,
    )
    return
  }
  say(`Pull request ${pull}'s preview: ${url}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`)
}

if (import.meta.main) {
  const [command, argument] = process.argv.slice(2)
  if (command === 'deploy') await deploy()
  else if (command === 'preview') await preview(argument)
  else {
    say('bun scripts/staging-website.ts deploy | preview <pull request>')
    process.exitCode = 2
  }
}
