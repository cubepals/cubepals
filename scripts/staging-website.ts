// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * staging.cubepals.com as the Cloudflare Worker `blockly-web-staging`: staging's values for
 * lib/web-worker.ts, and the two ways a commit reaches the Worker without the rest of staging.
 *
 *   bun scripts/staging-website.ts deploy        this checkout, built with staging's values and live,
 *                                                and the previews' router with it
 *   bun scripts/staging-website.ts preview <n>   this checkout as pull request <n>'s preview version,
 *                                                at pr-<n>.preview.cubepals.com, and at
 *                                                <sha7>.preview.cubepals.com until it closes
 *
 * The web-staging workflow runs both: deploy on each push to main, preview on each pull request
 * from this repository. Cloudflare serves a preview version at its workers.dev alias alone,
 * pr-<n>-blockly-web-staging.<subdomain>.workers.dev; the previews' router
 * (apps/web/preview-router.ts) answers for its branded address, through the proxied wildcard
 * record deploy keeps for it with CLOUDFLARE_API_TOKEN (DNS). A preview whose branded address
 * doesn't answer yet is named by its alias. Each upload's version keeps its own preview URL too,
 * which a newer upload doesn't take over: preview records it in Workers KV by its commit
 * (lib/preview-commits.ts), and the router answers for the commit's address with it. deploy makes
 * the namespace when it is missing and binds the router to it. `staging.ts up` deploys the Worker
 * with the rest of staging, from stagingSite, and tells staging's control plane to trust the
 * previews' addresses (previewOrigins).
 *
 * Neither command touches the control plane or the Worker's WEB_PROXY_SECRET: a version keeps the
 * secret `up` gave the Worker. CLOUDFLARE_WORKERS_API_TOKEN uploads it, to the account
 * CLOUDFLARE_ACCOUNT_ID names, or else the one holding cubepals.com, which CLOUDFLARE_API_TOKEN
 * (DNS) can look up. Nothing here prints a value. A preview's address goes to GITHUB_OUTPUT as
 * `url` when there is one, its version's id as `version`, and its commit's address as `commit_url`.
 */
import { appendFileSync } from 'node:fs'
import { pointRecord, zoneAccount } from './lib/cloudflare-dns.ts'
import { commitsNamespace, recordCommit } from './lib/preview-commits.ts'
import { buildWorker, deployRouter, deployWorker, uploadPreview, type WorkerSite } from './lib/web-worker.ts'

/** As staging.ts names them: the control app on fly.dev, and the site's one address. */
export const API = 'https://bly-staging-control.fly.dev'
export const WEB = 'https://staging.cubepals.com'
/** wrangler.jsonc's `staging` environment. */
const WORKER = 'blockly-web-staging'
/**
 * Where the previews are, as apps/web/preview-router.jsonc routes them: `pr-<n>.` or a commit's
 * first seven characters before it.
 */
export const PREVIEW_DOMAIN = 'preview.cubepals.com'

/** A pull request's branded preview address; `*` for the pattern they all match. */
export const brandedPreview = (pull: string) => `https://pr-${pull}.${PREVIEW_DOMAIN}`

/** A commit's branded preview address, which keeps the version uploaded for it. */
export const brandedCommit = (sha: string) => `https://${sha.slice(0, 7)}.${PREVIEW_DOMAIN}`

/** The pattern every commit's address matches: seven letters or digits, one label. */
export const COMMIT_PATTERN = `https://${'?'.repeat(7)}.${PREVIEW_DOMAIN}`

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

/** What follows `pr-<n>` in a preview's alias, on the account's workers.dev subdomain. */
export const aliasSuffix = (subdomain: string) => `-${WORKER}.${subdomain}.workers.dev`

/** The pattern every pull request's preview alias matches, under the account's workers.dev subdomain. */
export const previewPattern = (subdomain: string) => `https://pr-*${aliasSuffix(subdomain)}`

/** The patterns a pull request's addresses match, `*` standing for its number: branded and alias. */
export async function pullPatterns(cloudflare: Cloudflare): Promise<string[]> {
  return [brandedPreview('*'), previewPattern(await workersSubdomain(cloudflare))]
}

/**
 * WEB_TRUSTED_ORIGINS for staging's control plane: the previews at their branded addresses, and at
 * their aliases on the account's own subdomain, and each commit's branded address.
 */
export async function previewOrigins(cloudflare: Cloudflare): Promise<string[]> {
  return [...(await pullPatterns(cloudflare)), COMMIT_PATTERN]
}

/** The account's workers.dev subdomain, which the previews' aliases are under. */
async function workersSubdomain(cloudflare: Cloudflare): Promise<string> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cloudflare.accountId}/workers/subdomain`,
    { headers: { authorization: `Bearer ${cloudflare.token}` } },
  )
  const answer = (await response.json()) as { success: boolean; result?: { subdomain?: string } }
  const subdomain = answer.result?.subdomain
  if (!answer.success || !subdomain)
    throw new Error('Cloudflare named no workers.dev subdomain for the account')
  return subdomain
}

/** Whether a preview answers at an address within a minute: a new branded one may take that long. */
async function answers(url: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await fetch(`${url}/robots.txt`, { signal: AbortSignal.timeout(10_000) }).catch(
      () => null,
    )
    if (response?.ok) return true
    await Bun.sleep(5000)
  }
  return false
}

const head = () => Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim()

async function deploy(): Promise<void> {
  const site = stagingSite(await stagingCloudflare())
  const sha = head()
  buildWorker(site, sha, say)
  deployWorker(site, sha, say)
  const suffix = aliasSuffix(await workersSubdomain(site.cloudflare))
  const commits = await commitsNamespace(site.cloudflare)
  deployRouter(site, { PREVIEW_DOMAIN, PREVIEW_SUFFIX: suffix }, commits, say)
  const dns = process.env.CLOUDFLARE_API_TOKEN
  if (!dns) {
    say(`No CLOUDFLARE_API_TOKEN (DNS): *.${PREVIEW_DOMAIN} is left as it is.`)
    return
  }
  // Answered by the router's route alone, so it points nowhere: Cloudflare's convention for that.
  await pointRecord(dns, 'cubepals.com', {
    type: 'AAAA',
    name: `*.${PREVIEW_DOMAIN}`,
    content: '100::',
    proxied: true,
  })
}

/**
 * Records the commit's version for its branded address, and names that address in GITHUB_OUTPUT as
 * `commit_url`. A failure says so and leaves the pull request's own preview as it is.
 */
async function keepCommit(cloudflare: Cloudflare, sha: string, pull: number, versionUrl: string) {
  const prefix = new URL(versionUrl).hostname.split('-')[0] ?? ''
  if (!/^[0-9a-f]{8}$/.test(prefix)) {
    say(`::warning::${brandedCommit(sha)} has no version: wrangler named no version prefix.`)
    return
  }
  try {
    const namespace = await commitsNamespace(cloudflare)
    await recordCommit(cloudflare, namespace, { sha, pull, at: new Date().toISOString() }, prefix)
  } catch (error) {
    say(`::warning::${brandedCommit(sha)} has no version: ${(error as Error).message}`)
    return
  }
  say(`Commit ${sha.slice(0, 7)}'s preview: ${brandedCommit(sha)}`)
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `commit_url=${brandedCommit(sha)}\n`)
}

async function preview(pull: string | undefined): Promise<void> {
  if (!pull || !/^[1-9]\d*$/.test(pull)) throw new Error('Name the pull request by its number')
  const branded = brandedPreview(pull)
  const sha = head()
  const commit = brandedCommit(sha)
  const site = {
    ...stagingSite(await stagingCloudflare()),
    forwardedHosts: [new URL(branded).host, new URL(commit).host],
  }
  buildWorker(site, sha, say)
  const { url: alias, version, versionUrl } = uploadPreview(site, sha, `pr-${pull}`)
  if (version !== undefined && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
  if (versionUrl !== undefined) await keepCommit(site.cloudflare, sha, Number(pull), versionUrl)
  if (alias === undefined) {
    say(
      `Uploaded, but ${WORKER} has preview URLs off: a deploy with wrangler.jsonc's preview_urls turns them on.`,
    )
    return
  }
  const url = (await answers(branded)) ? branded : alias
  if (url === alias) say(`${branded} doesn't answer yet, so the preview is named by its alias.`)
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
