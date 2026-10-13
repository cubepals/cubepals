// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which sites may put worlds into staging's bucket. A browser uploads a world straight into it,
 * so its CORS rules name staging.cubepals.com and each open pull request's preview, and each of its
 * previewed commits, by exact origin: Tigris takes no wildcard in one.
 *
 *   bun scripts/preview-uploads.ts add <url>... the previews at each <url> may upload
 *   bun scripts/preview-uploads.ts remove <n>   pull request <n>'s preview may no longer
 *   bun scripts/preview-uploads.ts sweep        exactly the open pull requests' previews may
 *
 * The web-staging workflow runs these with the preview environment's STAGING_BUCKET_* secrets:
 * add once a preview is up, remove when its pull request closes, and sweep each day and on each
 * push to main, which also puts back an origin two pull requests' runs raced each other for.
 * sweep reads the open pull requests with GH_TOKEN from REPO, and the previews' workers.dev
 * subdomain and which commit is whose (lib/preview-commits.ts) with CLOUDFLARE_WORKERS_API_TOKEN;
 * it keeps each preview's branded origin and its alias, and each of its commits' origins, and
 * drops a commit's origin nobody recorded. Every other rule and origin stays as it was.
 *
 * `staging.ts up` keeps staging.cubepals.com in the rules with `allowing`, and gives the preview
 * environment a new bucket's keys with `sharePreviewKeys`. Nothing here prints a key. Not for the
 * bucket's objects: those are the control plane's.
 */
import { type CORSRule, GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3'
import { HOUR_S } from '@blockly/contracts/durations'
import { findCommits, listCommits, type PreviewCommit } from './lib/preview-commits.ts'
import { brandedCommit, pullPatterns, stagingCloudflare, WEB } from './staging-website.ts'

export interface Bucket {
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/** A preview's origin, branded or its alias, its pull request's number first. */
export const PREVIEW_ORIGIN =
  /^https:\/\/pr-(\d+)(?:\.preview\.cubepals\.com|-blockly-web-staging\.[a-z0-9-]+\.workers\.dev)$/

/** A previewed commit's branded origin, its first seven characters first. */
export const COMMIT_ORIGIN = /^https:\/\/([0-9a-f]{7})\.preview\.cubepals\.com$/

/** An upload's PUT, its checks, and the ETag a multipart upload reads back. */
const uploadRule = (origins: string[]): CORSRule => ({
  AllowedOrigins: origins,
  AllowedMethods: ['GET', 'PUT', 'HEAD'],
  AllowedHeaders: ['*'],
  ExposeHeaders: ['ETag'],
  MaxAgeSeconds: HOUR_S,
})

/**
 * The rules with every origin allowed. An origin a rule names already stays where it is; the rest
 * join the first rule naming any of them, or a new upload rule.
 */
export function allowing(rules: CORSRule[], origins: string[]): CORSRule[] {
  const named = new Set(rules.flatMap((rule) => rule.AllowedOrigins ?? []))
  const missing = [...new Set(origins)].filter((origin) => !named.has(origin))
  if (missing.length === 0) return rules
  const target = rules.findIndex((rule) => rule.AllowedOrigins?.some((origin) => origins.includes(origin)))
  if (target === -1) return [...rules, uploadRule(missing)]
  return rules.map((rule, index) =>
    index === target ? { ...rule, AllowedOrigins: [...(rule.AllowedOrigins ?? []), ...missing] } : rule,
  )
}

/**
 * The rules without the previews of pull requests `open` turns down, a commit's by whose `commits`
 * says it is: one it doesn't name counts as no open pull request's. A rule left naming nobody goes.
 */
export function closing(
  rules: CORSRule[],
  open: (pull: number) => boolean,
  commits: Map<string, PreviewCommit> = new Map(),
): CORSRule[] {
  const pullOf = (origin: string): number | undefined => {
    const commit = COMMIT_ORIGIN.exec(origin)?.[1]
    if (commit !== undefined) return commits.get(commit)?.pull ?? 0
    const pull = PREVIEW_ORIGIN.exec(origin)?.[1]
    return pull === undefined ? undefined : Number(pull)
  }
  return rules.flatMap((rule) => {
    const origins = (rule.AllowedOrigins ?? []).filter((origin) => {
      const pull = pullOf(origin)
      return pull === undefined || open(pull)
    })
    if (origins.length === rule.AllowedOrigins?.length) return [rule]
    return origins.length === 0 ? [] : [{ ...rule, AllowedOrigins: origins }]
  })
}

const client = (bucket: Bucket) =>
  new S3Client({
    endpoint: bucket.endpoint,
    region: bucket.region,
    credentials: { accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey },
  })

/** The bucket's CORS rules; none when it has no configuration. */
async function corsRules(bucket: Bucket): Promise<CORSRule[]> {
  try {
    const answer = await client(bucket).send(new GetBucketCorsCommand({ Bucket: bucket.name }))
    return answer.CORSRules ?? []
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchCORSConfiguration') return []
    throw error
  }
}

/** Reads the rules, changes them, and writes them back when that changed anything. */
export async function changeCors(
  bucket: Bucket,
  change: (rules: CORSRule[]) => CORSRule[],
): Promise<boolean> {
  const rules = await corsRules(bucket)
  const changed = change(rules)
  if (JSON.stringify(changed) === JSON.stringify(rules)) return false
  await client(bucket).send(
    new PutBucketCorsCommand({ Bucket: bucket.name, CORSConfiguration: { CORSRules: changed } }),
  )
  return true
}

/** The secrets the preview environment holds a bucket's keys in, each with its value. */
const previewSecrets = (bucket: Bucket): Record<string, string> => ({
  STAGING_BUCKET_NAME: bucket.name,
  STAGING_BUCKET_ENDPOINT: bucket.endpoint,
  STAGING_BUCKET_REGION: bucket.region,
  STAGING_BUCKET_ACCESS_KEY_ID: bucket.accessKeyId,
  STAGING_BUCKET_SECRET_ACCESS_KEY: bucket.secretAccessKey,
})

/**
 * The preview environment's copy of the bucket's keys, set with gh, each value on its input. Says
 * so and sets nothing when gh isn't signed in; a failure throws gh's last line, never a value.
 */
export function sharePreviewKeys(bucket: Bucket, say: (line: string) => void): void {
  if (Bun.spawnSync(['gh', 'auth', 'status'], { stdout: 'ignore', stderr: 'ignore' }).exitCode !== 0) {
    say(
      '  gh isn’t signed in, so the preview environment keeps the old bucket’s keys and can’t edit its CORS.',
    )
    say('  Sign in with `gh auth login`, then run `bun scripts/staging.ts preview-keys`.')
    return
  }
  for (const [name, value] of Object.entries(previewSecrets(bucket))) {
    const result = Bun.spawnSync(
      ['gh', 'secret', 'set', name, '--env', 'preview', '-R', 'cubepals/cubepals'],
      {
        stdin: Buffer.from(value),
        stdout: 'ignore',
        stderr: 'pipe',
      },
    )
    if (result.exitCode !== 0)
      throw new Error(`gh secret set ${name}: ${result.stderr.toString().trim().split('\n').at(-1)}`)
  }
  say('  gave the preview environment the bucket’s keys')
}

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const say = (line: string) => process.stdout.write(`${line}\n`)

/** The open pull requests from this repository's own branches: the ones that get a preview. */
export async function openPulls(repo: string): Promise<number[]> {
  const pulls: number[] = []
  for (let page = 1; ; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100&page=${page}`,
      {
        headers: { authorization: `Bearer ${need('GH_TOKEN')}`, accept: 'application/vnd.github+json' },
      },
    )
    if (!response.ok) throw new Error(`GitHub answered ${response.status} to the open pull requests`)
    const listed = (await response.json()) as {
      number: number
      head: { repo: { full_name: string } | null }
    }[]
    pulls.push(...listed.filter((pull) => pull.head.repo?.full_name === repo).map((pull) => pull.number))
    if (listed.length < 100) return pulls
  }
}

/** Adds the origins, then reads them back: another pull request's run may have written over them. */
async function add(bucket: Bucket, origins: string[]): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const changed = await changeCors(bucket, (rules) => allowing(rules, [WEB, ...origins]))
    await Bun.sleep(5000)
    const named = new Set((await corsRules(bucket)).flatMap((rule) => rule.AllowedOrigins ?? []))
    if (origins.every((origin) => named.has(origin))) {
      const which = origins.join(' and ')
      say(changed ? `${which} may upload worlds now.` : `${which} could already upload worlds.`)
      return
    }
  }
  throw new Error(`${origins.join(' or ')} went missing from the bucket's rules three times`)
}

/** Which commit is whose, as the previews' KV namespace records them; none before there is one. */
async function recordedCommits(): Promise<Map<string, PreviewCommit>> {
  const cloudflare = await stagingCloudflare()
  const namespace = await findCommits(cloudflare)
  return namespace === undefined ? new Map() : listCommits(cloudflare, namespace)
}

/** A preview's origin, branded, its alias or a commit's, from its address. */
const previewOrigin = (url: string): string | undefined => {
  const origin = URL.canParse(url) ? new URL(url).origin : ''
  return PREVIEW_ORIGIN.test(origin) || COMMIT_ORIGIN.test(origin) ? origin : undefined
}

if (import.meta.main) {
  const [command, argument = '', ...more] = process.argv.slice(2)
  const bucket: Bucket = {
    name: need('STAGING_BUCKET_NAME'),
    endpoint: need('STAGING_BUCKET_ENDPOINT'),
    region: need('STAGING_BUCKET_REGION'),
    accessKeyId: need('STAGING_BUCKET_ACCESS_KEY_ID'),
    secretAccessKey: need('STAGING_BUCKET_SECRET_ACCESS_KEY'),
  }
  const origins = [argument, ...more].map(previewOrigin)
  if (command === 'add' && origins.every((origin) => origin !== undefined)) {
    await add(bucket, origins as string[])
  } else if (command === 'remove' && /^\d+$/.test(argument)) {
    const pull = Number(argument)
    // Without the records, the closed pull request's commits wait for the sweep.
    const commits = await recordedCommits().catch(() => new Map<string, PreviewCommit>())
    const changed = await changeCors(bucket, (rules) => closing(rules, (other) => other !== pull, commits))
    say(changed ? `Pull request ${pull}'s preview may no longer upload worlds.` : 'Nothing to remove.')
  } else if (command === 'sweep') {
    const open = new Set(await openPulls(need('REPO')))
    const patterns = await pullPatterns(await stagingCloudflare())
    const commits = await recordedCommits()
    const origins = [
      ...patterns.flatMap((pattern) => [...open].map((pull) => pattern.replaceAll('*', String(pull)))),
      ...[...commits.values()]
        .filter((commit) => open.has(commit.pull))
        .map((commit) => brandedCommit(commit.sha)),
    ]
    const changed = await changeCors(bucket, (rules) =>
      allowing(
        closing(rules, (pull) => open.has(pull), commits),
        [WEB, ...origins],
      ),
    )
    say(`${changed ? 'Now' : 'Already'} ${open.size} open pull requests' previews may upload worlds.`)
  } else {
    say('bun scripts/preview-uploads.ts add <preview url>... | remove <pull request> | sweep')
    process.exitCode = 2
  }
}
