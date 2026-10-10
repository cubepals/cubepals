/**
 * Every value production needs before it can come up (docs/production.md): what each is, where the
 * operator gets it, and where it goes. `bun scripts/production.ts` reads them from one file the
 * operator keeps, local/production/production.env, checks them, and hands them to Terraform.
 * Running Terraform, flyctl and git stays in production.ts.
 *
 * The file is the only source. The shell's own variables never stand in for it: a shell set up
 * for staging carries staging's FLY_API_TOKEN, which must never reach production.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { loadConfig } from '../apps/control/src/config/load.ts'

const ROOT = join(import.meta.dir, '..')
export const ENVIRONMENT_DIR = 'infra/terraform/environments/production'
/** Production's decided values, which git ignores: the example beside it, copied and filled in. */
export const ENVIRONMENT_FILE = `${ENVIRONMENT_DIR}/config.auto.tfvars.json`
export const ENVIRONMENT_EXAMPLE = `${ENVIRONMENT_DIR}/config.auto.tfvars.example.json`
export const VALUES_FILE = 'local/production/production.env'
export const STATE_BUCKET = 'blockly-terraform-state'
/** Where the Database dump workflow puts production's database every night: Terraform makes it. */
export const DUMPS_BUCKET = 'blockly-prod-database-dumps'
/** The repository's GitHub environment whose secrets that workflow reads. */
export const DUMPS_ENVIRONMENT = 'production'

/**
 * Where a value goes. `secret` and `operator` reach the control plane (TF_VAR_secrets,
 * TF_VAR_operator_settings); `web` reaches only the Vercel project's production builds
 * (TF_VAR_web_secrets); `account` is a TF_VAR of its own; `apply` is only for the tools that
 * apply, and FLY_API_TOKEN is both that and a secret. `dump` reaches only the Database dump
 * workflow, as a secret of the repository's `production` environment (dumpSecrets).
 */
export type Destination = 'secret' | 'operator' | 'web' | 'account' | 'apply' | 'dump'

export interface Value {
  name: string
  goes: Destination[]
  /** Where the operator gets it; empty for the ones this script makes. */
  where: string
  /** Leaving it out turns a capability off. Values sharing a group come together or not at all. */
  optional?: string
  /** Made by `init`: random, never typed. */
  generate?: () => string
  /** Made only once the first apply has made the archive and dumps buckets. */
  afterBucket?: boolean
  /** What's wrong with a value, if its shape shows it. */
  shape?: (value: string) => string | null
}

const random = () => randomBytes(36).toString('base64url')
const startsWith =
  (prefixes: string[], what: string) =>
  (value: string): string | null =>
    prefixes.some((p) => value.startsWith(p)) ? null : what

const CLOUDFLARE_ID = (value: string) => (/^[0-9a-f]{32}$/.test(value) ? null : 'is 32 hex characters')
const R2_TOKEN = 'R2 → Manage API tokens → Create Account API token: Object Read & Write'
const POLAR =
  'only to charge, from Polar (polar.sh, production, not the sandbox) → Settings → Developers. See docs/production.md § Billing'

export const VALUES: Value[] = [
  {
    name: 'CLOUDFLARE_ACCOUNT_ID',
    goes: ['account'],
    where: 'Cloudflare → cubepals.com → Overview, right column: Account ID',
    shape: CLOUDFLARE_ID,
  },
  {
    name: 'CLOUDFLARE_ZONE_ID',
    goes: ['account'],
    where: 'Cloudflare → cubepals.com → Overview, right column: Zone ID',
    shape: CLOUDFLARE_ID,
  },
  {
    name: 'CLOUDFLARE_API_TOKEN',
    goes: ['apply'],
    where:
      'Cloudflare → My Profile → API Tokens → Create Token → Custom token: Zone · DNS · Edit on cubepals.com, and Account · Workers R2 Storage · Edit',
  },
  {
    name: 'VERCEL_API_TOKEN',
    goes: ['apply'],
    where: 'vercel.com → Account Settings → Tokens → Create, scoped to the team in config.auto.tfvars.json',
  },
  {
    name: 'TF_STATE_ACCESS_KEY_ID',
    goes: ['apply'],
    where: `Cloudflare → R2 → Create bucket ${STATE_BUCKET}; then ${R2_TOKEN}, that bucket only: Access Key ID`,
  },
  {
    name: 'TF_STATE_SECRET_ACCESS_KEY',
    goes: ['apply'],
    where: 'the same R2 token: Secret Access Key',
  },
  {
    name: 'FLY_API_TOKEN',
    goes: ['apply', 'secret'],
    where: 'fly orgs create blockly-prod (and a card on it), then: fly tokens create org blockly-prod',
    shape: startsWith(['FlyV1 ', 'fm2_'], 'is an org token from fly tokens create org (FlyV1 …)'),
  },
  {
    name: 'DATABASE_URL',
    goes: ['secret'],
    where:
      'Supabase → cubepals prod → Connect → Session pooler (port 5432), as the role blockly on the database blockly, with ?sslmode=verify-full&sslrootcert=/app/packages/db/certs/supabase-root-2021.crt (the root the control image carries)',
    shape: startsWith(['postgres://', 'postgresql://'], 'is a postgres:// URL'),
  },
  {
    name: 'DATABASE_DIRECT_URL',
    goes: ['secret'],
    where:
      'the same session pooler URL: it carries LISTEN, migrations and pg_dump, which need a session of their own',
    shape: startsWith(['postgres://', 'postgresql://'], 'is a postgres:// URL'),
  },
  {
    name: 'AUTH_GOOGLE_CLIENT_ID',
    goes: ['secret'],
    where:
      'console.cloud.google.com → Google Auth Platform → Clients → Create client → Web application. Origin https://cubepals.com; redirect https://cubepals.com/api/auth/callback/google',
    shape: (value) =>
      value.endsWith('.apps.googleusercontent.com') ? null : 'ends in .apps.googleusercontent.com',
  },
  { name: 'AUTH_GOOGLE_CLIENT_SECRET', goes: ['secret'], where: 'the same OAuth client: Client secret' },
  {
    name: 'SMTP_URL',
    goes: ['secret'],
    where: "the mail provider's SMTP settings for hello@cubepals.com, as smtps://user:password@host:465",
    shape: startsWith(['smtp://', 'smtps://'], 'is an smtp:// or smtps:// URL'),
  },
  {
    name: 'CLOUDFLARE_DNS_API_TOKEN',
    goes: ['secret'],
    where:
      'Cloudflare → My Profile → API Tokens → Create Token → "Edit zone DNS" template, zone cubepals.com',
  },
  {
    name: 'ARCHIVE_S3_ACCESS_KEY_ID',
    goes: ['secret'],
    where: `after the first apply makes the bucket: Cloudflare → ${R2_TOKEN}, blockly-prod-archives only: Access Key ID`,
    afterBucket: true,
  },
  {
    name: 'ARCHIVE_S3_SECRET_ACCESS_KEY',
    goes: ['secret'],
    where: 'the same R2 token: Secret Access Key',
    afterBucket: true,
  },
  {
    name: 'DUMP_S3_ACCESS_KEY_ID',
    goes: ['dump'],
    where: `after the first apply makes the bucket: Cloudflare → ${R2_TOKEN}, ${DUMPS_BUCKET} only: Access Key ID`,
    afterBucket: true,
  },
  {
    name: 'DUMP_S3_SECRET_ACCESS_KEY',
    goes: ['dump'],
    where: 'the same R2 token: Secret Access Key',
    afterBucket: true,
  },
  { name: 'AUTH_SECRET', goes: ['secret'], where: '', generate: random },
  { name: 'WEB_PROXY_SECRET', goes: ['secret'], where: '', generate: random },
  { name: 'REALTIME_TICKET_SECRET', goes: ['secret'], where: '', generate: random },
  { name: 'EDGE_TOKEN', goes: ['secret'], where: '', generate: random },
  { name: 'RUNTIME_SECRETS_KEY', goes: ['secret'], where: '', generate: () => `1:${random()}` },
  {
    name: 'ADMIN_EMAILS',
    goes: ['operator'],
    where: 'your own email, once confirmed an admin; comma-separate more',
  },
  {
    name: 'ACME_EMAIL',
    goes: ['operator'],
    where: "where Let's Encrypt writes about rt.cubepals.com's certificate",
  },
  {
    name: 'ACME_AGREE_TOS',
    goes: ['operator'],
    where: "true, once you accept Let's Encrypt's Subscriber Agreement (letsencrypt.org/repository)",
    shape: (value) => (value === 'true' ? null : 'is true, once you accept the terms'),
  },
  {
    name: 'POLAR_ACCESS_TOKEN',
    goes: ['secret'],
    where: `${POLAR}: an organization access token`,
    optional: 'billing',
  },
  {
    name: 'POLAR_WEBHOOK_SECRET',
    goes: ['secret'],
    where: 'Polar → Settings → Webhooks, the endpoint https://cubepals.com/api/billing/webhook: its secret',
    optional: 'billing',
    shape: startsWith(['whsec_'], 'starts with whsec_'),
  },
  {
    name: 'POLAR_PRODUCTS',
    goes: ['operator'],
    where: 'Polar → Products: plus:<the Plus product id>',
    optional: 'billing',
  },
  {
    name: 'AUTH_GITHUB_CLIENT_ID',
    goes: ['secret'],
    where:
      'only for GitHub sign-in: github.com → Settings → Developer settings → OAuth Apps → New, callback https://cubepals.com/api/auth/callback/github',
    optional: 'github',
  },
  { name: 'AUTH_GITHUB_CLIENT_SECRET', goes: ['secret'], where: 'the same OAuth app', optional: 'github' },
  {
    name: 'POSTHOG_PERSONAL_API_KEY',
    goes: ['web'],
    where:
      'only for readable errors: PostHog → Settings → Personal API keys → Create, error tracking write and organization read',
    optional: 'sourcemaps',
    shape: startsWith(['phx_'], 'starts with phx_'),
  },
  {
    name: 'POSTHOG_PROJECT_ID',
    goes: ['web'],
    where: 'the same PostHog project: Settings → Project → Project ID',
    optional: 'sourcemaps',
    shape: (value) => (/^\d+$/.test(value) ? null : 'is a number'),
  },
]

/** NAME=value lines; `#` starts a comment, and quotes around a value are dropped. */
export function parseValues(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line)
    if (!match?.[1]) continue
    const value = (match[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value !== '') values[match[1]] = value
  }
  return values
}

/**
 * The file `init` writes: every value with where it comes from, the random ones made, and
 * whatever `existing` already holds kept as it was.
 */
export function valuesFile(existing: Record<string, string>): string {
  const lines = [
    '# Production’s values (docs/production.md). Never commit this file or paste it anywhere.',
    '# Fill in each empty one, then run: bun scripts/production.ts check',
    '',
  ]
  for (const value of VALUES) {
    const made = existing[value.name] ?? value.generate?.() ?? ''
    if (value.where) lines.push(`# ${value.optional ? '(optional) ' : ''}${value.where}`)
    else lines.push('# made here, random')
    lines.push(`${value.name}=${made}`, '')
  }
  return lines.join('\n')
}

export interface Problems {
  /** Values to fill in now. */
  missing: Value[]
  /** Values filled in, but not in a shape that works. */
  wrong: string[]
  /** Only the buckets' tokens are left: the first apply makes the buckets for them. */
  bucketFirst: boolean
}

/** What stands between the file and an apply. Names values, never prints them. */
export function problemsOf(values: Record<string, string>, env?: Environment): Problems {
  const missing = VALUES.filter((v) => !v.optional && !v.afterBucket && !values[v.name])
  const waiting = VALUES.filter((v) => v.afterBucket && !values[v.name])
  const wrong = wrongValues(values)
  // A bucket's token can't exist before the bucket does: the check stands in for it until then.
  const standIns = Object.fromEntries(waiting.map((v) => [v.name, 'stand-in-until-the-bucket-exists']))
  if (missing.length === 0 && wrong.length === 0)
    wrong.push(...configProblems({ ...values, ...standIns }, env))
  return { missing: [...missing, ...waiting], wrong, bucketFirst: missing.length === 0 && waiting.length > 0 }
}

/** Values given in a shape that can't work, half a capability, or under a name nothing reads. */
function wrongValues(values: Record<string, string>): string[] {
  const wrong: string[] = []
  for (const value of VALUES) {
    const given = values[value.name]
    const problem = given ? value.shape?.(given) : null
    if (problem) wrong.push(`${value.name} ${problem}.`)
  }
  for (const group of new Set(VALUES.flatMap((v) => (v.optional ? [v.optional] : [])))) {
    const members = VALUES.filter((v) => v.optional === group)
    const given = members.filter((v) => values[v.name])
    if (given.length > 0 && given.length < members.length)
      wrong.push(`${members.map((v) => v.name).join(', ')} come together, or not at all (${group}).`)
  }
  const known = new Set(VALUES.map((v) => v.name))
  for (const name of Object.keys(values))
    if (!known.has(name)) wrong.push(`${name} isn't a value production uses. Check its name.`)
  return wrong
}

export interface Environment {
  fly_org: string
  fly_machine_limit: number
  settings: Record<string, string>
  vercel_team: string
  web: { repository: string; project: string }
}

export function environment(file = ENVIRONMENT_FILE): Environment {
  if (!existsSync(join(ROOT, file)))
    throw new Error(`There is no ${file}: copy ${ENVIRONMENT_EXAMPLE} to it.`)
  return JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as Environment
}

/** What a Fly app's config sets: its [env], and ROLES from a process group's command. */
function flyEnv(app: string, processGroup?: string): Record<string, string> {
  const config = parse(readFileSync(join(ROOT, `infra/fly/${app}.toml`), 'utf8')) as {
    env?: Record<string, string>
    processes?: Record<string, string>
  }
  const roles = processGroup ? /ROLES=(\S+)/.exec(config.processes?.[processGroup] ?? '')?.[1] : undefined
  return { ...config.env, ...(roles ? { ROLES: roles } : {}) }
}

/**
 * The control plane's own check of its configuration, run on these values with what Terraform
 * computes and each Fly app sets, as every production machine will at its first start. An
 * inconsistency stops it here, before anything is made.
 */
function configProblems(values: Record<string, string>, env = environment()): string[] {
  const id = env.settings.DEPLOYMENT_ID
  const computed = {
    ARTIFACTS_RUNTIME_FACING_URL: `https://bly-${id}-control.fly.dev`,
    ARCHIVE_S3_ENDPOINT: `https://${values.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    FLY_MACHINE_LIMIT: String(env.fly_machine_limit),
    FLY_PLATFORM_MACHINES: '7',
    CLOUDFLARE_ZONE_ID: values.CLOUDFLARE_ZONE_ID ?? '',
  }
  const given = Object.fromEntries(
    VALUES.filter((v) => v.goes.includes('secret') || v.goes.includes('operator')).flatMap((v) =>
      values[v.name] ? [[v.name, values[v.name] as string]] : [],
    ),
  )
  const problems: string[] = []
  for (const [app, group] of [['control', 'api'], ['control', 'worker'], ['realtime']] as const) {
    try {
      loadConfig({ ...env.settings, ...computed, ...given, ...flyEnv(app, group) })
    } catch (error) {
      problems.push(`The ${group ?? app} role wouldn't start: ${(error as Error).message}`)
    }
  }
  return [...new Set(problems)]
}

/**
 * A short digest of each secret, as its secret_versions marker: a changed value is sent to Fly
 * again, and an unchanged one isn't. No value can be read back from twelve hex characters.
 */
const versionOf = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12)

/** The environment Terraform runs in: its variables and the providers' tokens. Never printed. */
export function terraformEnv(values: Record<string, string>): Record<string, string> {
  const pick = (to: Destination) =>
    Object.fromEntries(
      VALUES.filter((v) => v.goes.includes(to) && values[v.name]).map((v) => [
        v.name,
        values[v.name] as string,
      ]),
    )
  const secrets = pick('secret')
  const web = pick('web')
  return {
    TF_VAR_secrets: JSON.stringify(secrets),
    TF_VAR_secret_versions: JSON.stringify(
      Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, versionOf(value)])),
    ),
    TF_VAR_operator_settings: JSON.stringify(pick('operator')),
    TF_VAR_web_secrets: JSON.stringify(web),
    TF_VAR_web_secret_versions: JSON.stringify(
      Object.fromEntries(Object.entries(web).map(([name, value]) => [name, versionOf(value)])),
    ),
    TF_VAR_cloudflare_account_id: values.CLOUDFLARE_ACCOUNT_ID ?? '',
    TF_VAR_cloudflare_zone_id: values.CLOUDFLARE_ZONE_ID ?? '',
    TF_VAR_database_dumps_bucket: DUMPS_BUCKET,
    FLY_API_TOKEN: values.FLY_API_TOKEN ?? '',
    CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN ?? '',
    VERCEL_API_TOKEN: values.VERCEL_API_TOKEN ?? '',
    // The S3 backend's credentials, for the state bucket alone.
    AWS_ACCESS_KEY_ID: values.TF_STATE_ACCESS_KEY_ID ?? '',
    AWS_SECRET_ACCESS_KEY: values.TF_STATE_SECRET_ACCESS_KEY ?? '',
  }
}

/**
 * A database URL whose root certificate is named where the control image keeps it, named where a
 * checkout of the repository keeps it instead, as the Database dump workflow runs from one.
 */
function inCheckout(url: string): string {
  if (!url) return url
  const database = new URL(url)
  const root = database.searchParams.get('sslrootcert')
  if (root?.startsWith('/app/')) database.searchParams.set('sslrootcert', root.slice('/app/'.length))
  return database.toString()
}

/**
 * The Database dump workflow's values (scripts/database-dump.ts), as secrets of the repository's
 * `production` environment. Its database URL is the direct one: pg_dump needs a session of its own,
 * which a transaction pooler can't give it.
 */
export function dumpSecrets(values: Record<string, string>): Record<string, string> {
  return {
    DATABASE_URL: inCheckout(values.DATABASE_DIRECT_URL ?? ''),
    DUMP_S3_ENDPOINT: `https://${values.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    DUMP_S3_BUCKET: DUMPS_BUCKET,
    DUMP_S3_ACCESS_KEY_ID: values.DUMP_S3_ACCESS_KEY_ID ?? '',
    DUMP_S3_SECRET_ACCESS_KEY: values.DUMP_S3_SECRET_ACCESS_KEY ?? '',
  }
}

/** backend.hcl: production's state, in the operator's R2 bucket. Holds the account id, no secret. */
export function backendConfig(accountId: string): string {
  return [
    `bucket                      = "${STATE_BUCKET}"`,
    'key                         = "production.tfstate"',
    'region                      = "auto"',
    `endpoints                   = { s3 = "https://${accountId}.r2.cloudflarestorage.com" }`,
    'skip_credentials_validation = true',
    'skip_region_validation      = true',
    'skip_requesting_account_id  = true',
    'skip_s3_checksum            = true',
    'use_path_style              = true',
    '',
  ].join('\n')
}
