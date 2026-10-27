// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The web app as a Cloudflare Worker (apps/web/wrangler.jsonc) for one environment: built from this
 * checkout with that environment's values, checked, deployed or uploaded as a preview, and put back
 * to the version that ran before. production-website.ts gives it production's values;
 * staging-website.ts gives it staging's.
 *
 * Next writes some values into the build (the /api rewrite's target, robots.txt, the PostHog token,
 * the version) and reads others as it runs, so one set of values makes both: the build's
 * environment, and the deploy's vars and secrets file. Before it deploys, the build is checked
 * against them, so a build made with another environment's values never goes out.
 *
 * The build sees only the shell's basics and these values, never a token. Wrangler signs in with
 * the Workers token given here, as CLOUDFLARE_API_TOKEN in its own environment only. Nothing here
 * prints a value.
 */
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WEB = join(import.meta.dir, '../../apps/web')
const BIN = join(import.meta.dir, '../../node_modules/.bin')

export interface WorkerSite {
  /** The wrangler environment: none for production's `blockly-web`, `staging` for `blockly-web-staging`. */
  env?: 'staging'
  /** API_UPSTREAM: the control plane's public origin. */
  apiUpstream: string
  /** WEB_CANONICAL_ORIGIN: the site's one address. */
  canonicalOrigin: string
  /** WEB_FORWARDED_HOST: a preview's branded addresses, which the previews' router reaches it by. */
  forwardedHosts?: string[]
  /** DEPLOYMENT_ID, by which every PostHog event says which environment built the page. */
  deploymentId: string
  /** Whether search engines may index it: production's alone. */
  indexable: boolean
  /** WEB_BEDROCK: whether the pages say Bedrock works (apps/web/src/lib/bedrock.ts). Off unless true. */
  bedrock?: boolean
  /** WEB_BETA: whether the site says it is in beta (apps/web/src/lib/beta.ts). On unless false. */
  beta?: boolean
  /** WEB_PROXY_SECRET, the control plane's. Without it, a version keeps the one the Worker has. */
  proxySecret?: string
  /** NEXT_PUBLIC_POSTHOG_TOKEN; without it the browser sends PostHog nothing. */
  posthogToken?: string
  /** POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID: with both, the build uploads its source maps. */
  sourceMaps?: { key: string; project: string }
  /** A token that may edit Workers and R2 on the account, and the account's id. */
  cloudflare: { token: string; accountId: string }
}

/**
 * What a build or wrangler may have of the shell's own environment: no token, no secret. The proxy
 * and the certificates to trust it are there for a machine whose HTTPS goes through one, where the
 * build's own fetches (npm, fonts) and wrangler's fail without them.
 */
const SHELL = [
  'PATH',
  'HOME',
  'TMPDIR',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'CI',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
]
const shell = () =>
  Object.fromEntries(SHELL.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])))

/** Read as the Worker runs: the deploy sets them as vars. */
function runtimeVars(site: WorkerSite): Record<string, string> {
  return {
    API_UPSTREAM: site.apiUpstream,
    WEB_CANONICAL_ORIGIN: site.canonicalOrigin,
    // Cloudflare sets and overwrites it with the address that reached its edge.
    WEB_CLIENT_ADDRESS_HEADER: 'cf-connecting-ip',
    ...(site.forwardedHosts ? { WEB_FORWARDED_HOST: site.forwardedHosts.join(',') } : {}),
    ...(site.indexable ? { WEB_INDEXABLE: '1' } : {}),
    ...(site.bedrock === true ? { WEB_BEDROCK: '1' } : {}),
    ...(site.beta === false ? { WEB_BETA: '0' } : {}),
  }
}

/** Written into the build: the runtime's values, and what only the build reads. */
function buildEnv(site: WorkerSite, sha: string): Record<string, string> {
  return {
    ...shell(),
    ...runtimeVars(site),
    DEPLOYMENT_ID: site.deploymentId,
    GIT_COMMIT_SHA: sha,
    NEXT_TELEMETRY_DISABLED: '1',
    ...(site.posthogToken ? { NEXT_PUBLIC_POSTHOG_TOKEN: site.posthogToken } : {}),
    ...(site.sourceMaps
      ? { POSTHOG_PERSONAL_API_KEY: site.sourceMaps.key, POSTHOG_PROJECT_ID: site.sourceMaps.project }
      : {}),
  }
}

function wranglerEnv(site: WorkerAccess): Record<string, string> {
  if (!site.cloudflare.token || !site.cloudflare.accountId)
    throw new Error('Deploying the website needs a Cloudflare Workers token and the account id')
  return {
    ...shell(),
    CLOUDFLARE_API_TOKEN: site.cloudflare.token,
    CLOUDFLARE_ACCOUNT_ID: site.cloudflare.accountId,
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_HIDE_BANNER: 'true',
  }
}

/** What listing and rolling back versions need of a site: the Worker and the account's token. */
export type WorkerAccess = Pick<WorkerSite, 'env' | 'cloudflare'>

/** wrangler.jsonc's environment, named even when it is the top level (`--env=`), as wrangler asks. */
const envArgs = (site: WorkerAccess) => [`--env=${site.env ?? ''}`]
const workerName = (site: WorkerAccess) => (site.env ? `blockly-web-${site.env}` : 'blockly-web')

/** What's wrong with a build for this site, if anything: robots.txt and the /api rewrite's target. */
export function buildProblems(site: WorkerSite, nextDir = join(WEB, '.next')): string[] {
  const problems: string[] = []
  const robotsFile = join(nextDir, 'server/app/robots.txt.body')
  const robots = existsSync(robotsFile) ? readFileSync(robotsFile, 'utf8').split('\n') : []
  const closed = robots.some((line) => line.trim() === 'Disallow: /')
  const open = robots.some((line) => line.trim() === 'Allow: /')
  if (site.indexable && (closed || !open)) problems.push('robots.txt turns search engines away')
  if (!site.indexable && !closed) problems.push('robots.txt lets search engines in')
  const manifest = JSON.parse(readFileSync(join(nextDir, 'routes-manifest.json'), 'utf8')) as {
    rewrites:
      | { source: string; destination: string }[]
      | Record<string, { source: string; destination: string }[]>
  }
  const rewrites = Array.isArray(manifest.rewrites)
    ? manifest.rewrites
    : Object.values(manifest.rewrites).flat()
  const api = rewrites.find((rewrite) => rewrite.source === '/api/:path*')
  if (api?.destination !== `${site.apiUpstream}/api/:path*`)
    problems.push(`/api goes to ${api?.destination ?? 'nowhere'}, not ${site.apiUpstream}`)
  return problems
}

/**
 * The Worker built from this checkout as `sha`, with the site's values, and checked. A site search
 * engines may not index says so on its static files too, which never pass through the Worker.
 */
export function buildWorker(site: WorkerSite, sha: string, say: (line: string) => void): void {
  say(`Building ${workerName(site)} from ${sha.slice(0, 8)}.`)
  const built = spawnSync(join(BIN, 'opennextjs-cloudflare'), ['build'], {
    cwd: WEB,
    env: buildEnv(site, sha),
    stdio: 'inherit',
  })
  if (built.status !== 0) throw new Error(`The website's build stopped (exit ${built.status}).`)
  if (!site.indexable)
    appendFileSync(join(WEB, '.open-next/assets/_headers'), '\n/*\n  X-Robots-Tag: noindex\n')
  const problems = buildProblems(site)
  if (problems.length > 0)
    throw new Error(`The website's build doesn't match its environment: ${problems.join('; ')}.`)
}

/**
 * OpenNext's `deploy` or `upload` of the last build, as a version tagged with its commit: OpenNext
 * puts the prerendered pages in the cache bucket, under the build's own id, then wrangler uploads
 * the Worker with its vars and, when the site has it, the secret. `extra` is the command's own.
 */
function sendVersion(
  site: WorkerSite,
  sha: string,
  command: 'deploy' | 'upload',
  extra: { args?: string[]; env?: Record<string, string> } = {},
): void {
  const dir = mkdtempSync(join(tmpdir(), 'blockly-web-'))
  const secrets = join(dir, 'secrets.json')
  if (site.proxySecret !== undefined)
    writeFileSync(secrets, JSON.stringify({ WEB_PROXY_SECRET: site.proxySecret }), { mode: 0o600 })
  try {
    const args = [
      command,
      ...envArgs(site),
      '--tag',
      sha.slice(0, 12),
      '--message',
      sha,
      ...Object.entries(runtimeVars(site)).flatMap(([name, value]) => ['--var', `${name}:${value}`]),
      ...(site.proxySecret !== undefined ? ['--secrets-file', secrets] : []),
      ...(extra.args ?? []),
    ]
    // OpenNext hands its arguments to wrangler through a shell, unquoted.
    const unsafe = args.find((arg) => !/^[\w.:/@=+,-]+$/.test(arg))
    if (unsafe !== undefined)
      throw new Error(`A ${command} argument a shell would misread: ${unsafe.split(':')[0]}`)
    // Wrangler's upload sometimes drops with "fetch failed" on the runner. The same tag sent again
    // replaces what a dropped attempt left, so two more tries, a little apart, ride that out.
    for (let tries = 1; ; tries++) {
      const sent = spawnSync(join(BIN, 'opennextjs-cloudflare'), args, {
        cwd: WEB,
        env: { ...wranglerEnv(site), ...extra.env },
        stdio: 'inherit',
      })
      if (sent.status === 0) break
      if (tries === 3) throw new Error(`The website's ${command} stopped (exit ${sent.status}).`)
      console.log(`The website's ${command} stopped (exit ${sent.status}); trying again.`)
      Bun.sleepSync(15_000)
    }
  } finally {
    if (existsSync(secrets)) unlinkSync(secrets)
    rmdirSync(dir)
  }
}

/** The last build deployed as the live version. Live when it returns. */
export function deployWorker(site: WorkerSite, sha: string, say: (line: string) => void): void {
  sendVersion(site, sha, 'deploy')
  say(`${workerName(site)} is live from ${sha.slice(0, 8)}.`)
}

/**
 * The previews' router (apps/web/preview-router.jsonc) deployed with its vars: which addresses are
 * previews, and the aliases they stand for; and bound to `commits`, the KV namespace naming each
 * commit's version, whose id only the account knows, so it goes into a copy of the config. Its
 * routes go with it: wrangler makes what is missing.
 */
export function deployRouter(
  site: WorkerSite,
  vars: { PREVIEW_DOMAIN: string; PREVIEW_SUFFIX: string },
  commits: string,
  say: (line: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'blockly-web-previews-'))
  const config = routerConfig(readFileSync(join(WEB, 'preview-router.jsonc'), 'utf8'), commits)
  writeFileSync(join(dir, 'wrangler.json'), JSON.stringify(config))
  try {
    const result = spawnSync(
      join(BIN, 'wrangler'),
      [
        'deploy',
        '--config',
        join(dir, 'wrangler.json'),
        ...Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`]),
      ],
      { cwd: WEB, env: wranglerEnv(site), stdio: 'inherit' },
    )
    if (result.status !== 0) throw new Error(`The previews' router's deploy stopped (exit ${result.status}).`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  say("The previews' router is live.")
}

/** preview-router.jsonc as wrangler gets it: its entry by its whole path, and bound to `commits`. */
export function routerConfig(jsonc: string, commits: string): Record<string, unknown> {
  const config = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>
  delete config.$schema
  return {
    ...config,
    main: join(WEB, String(config.main)),
    kv_namespaces: [{ binding: 'COMMITS', id: commits }],
  }
}

/**
 * A preview as wrangler reports it: its version, the alias's address when there is one, and the
 * version's own address, which keeps serving it after newer uploads.
 */
export interface PreviewUpload {
  url: string | undefined
  version: string | undefined
  versionUrl: string | undefined
}

/**
 * The last build uploaded as a version that isn't live, under `alias`, which names its preview
 * address: `https://<alias>-<worker>.<account's subdomain>.workers.dev`. That address, as wrangler
 * reports it, or undefined when the Worker's preview URLs are off (wrangler.jsonc's preview_urls,
 * which a deploy applies and an upload doesn't); and the version's id.
 */
export function uploadPreview(site: WorkerSite, sha: string, alias: string): PreviewUpload {
  const dir = mkdtempSync(join(tmpdir(), 'blockly-web-preview-'))
  const output = join(dir, 'wrangler-output.json')
  try {
    sendVersion(site, sha, 'upload', {
      args: ['--preview-alias', alias],
      env: { WRANGLER_OUTPUT_FILE_PATH: output },
    })
    return existsSync(output)
      ? previewUpload(readFileSync(output, 'utf8'))
      : { url: undefined, version: undefined, versionUrl: undefined }
  } finally {
    if (existsSync(output)) unlinkSync(output)
    rmdirSync(dir)
  }
}

/** The upload's entry in wrangler's output file: one JSON object a line. */
export function previewUpload(output: string): PreviewUpload {
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const entry = JSON.parse(line) as {
      type?: string
      version_id?: string | null
      preview_url?: string | null
      preview_alias_url?: string | null
    }
    if (entry.type === 'version-upload')
      return {
        url: entry.preview_alias_url || undefined,
        version: entry.version_id || undefined,
        versionUrl: entry.preview_url || undefined,
      }
  }
  return { url: undefined, version: undefined, versionUrl: undefined }
}

/** A wrangler command's JSON answer. */
function wranglerJson<T>(site: WorkerAccess, args: string[]): T {
  const result = spawnSync(join(BIN, 'wrangler'), [...args, ...envArgs(site), '--json'], {
    cwd: WEB,
    env: wranglerEnv(site),
    encoding: 'utf8',
  })
  if (result.status !== 0)
    throw new Error(`wrangler ${args.join(' ')}: ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`)
  // From the first line that opens JSON, past anything wrangler says before it.
  return JSON.parse(result.stdout.slice(Math.max(0, result.stdout.search(/^[[{]/m)))) as T
}

export interface LiveVersion {
  version: string
  /** The commit it was built from, as its deploy tagged it; unknown past the last ten versions. */
  commit?: string
}

/** The versions that have been live, the current one first, each once in a row. */
export function liveVersions(site: WorkerAccess): LiveVersion[] {
  const deployments = wranglerJson<{ versions: { version_id: string; percentage: number }[] }[]>(site, [
    'deployments',
    'list',
  ])
  const versions = wranglerJson<{ id: string; annotations?: Record<string, string> }[]>(site, [
    'versions',
    'list',
  ])
  const commitOf = new Map(versions.map((version) => [version.id, version.annotations?.['workers/message']]))
  const live: LiveVersion[] = []
  for (const deployment of [...deployments].reverse()) {
    const whole = deployment.versions.find((version) => version.percentage === 100)
    if (whole && live.at(-1)?.version !== whole.version_id)
      live.push({ version: whole.version_id, commit: commitOf.get(whole.version_id) })
  }
  return live
}

/** A version that ran before live again, at once and without a build. */
export function rollbackWorker(site: WorkerAccess, to: LiveVersion, say: (line: string) => void): void {
  const commit = to.commit?.slice(0, 8) ?? 'an earlier commit'
  const result = spawnSync(
    join(BIN, 'wrangler'),
    ['rollback', to.version, ...envArgs(site), '--message', `Back to ${commit}`, '--yes'],
    { cwd: WEB, env: wranglerEnv(site), stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error(`wrangler rollback stopped (exit ${result.status}).`)
  say(`${workerName(site)} is back on ${commit}.`)
}
