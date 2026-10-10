/**
 * Staging on Fly. It stays: when nobody is testing, its machines are stopped, which keeps its
 * database, worlds, bucket, secrets and two addresses, and costs only their storage and about $4
 * a month for the addresses.
 *
 *   bun scripts/staging.ts up       every part, in the `blockly-staging` org, deployed from this checkout
 *   bun scripts/staging.ts stop     every machine in the org stopped, the servers' included
 *   bun scripts/staging.ts start    the platform started again, as it was; servers start when played
 *   bun scripts/staging.ts status   what exists there now, and where to reach it
 *   bun scripts/staging.ts env      what a cloud environment needs to run all of this, written to
 *                                   local/staging/cloud.env to paste into its settings
 *   bun scripts/staging.ts down     destroys every part, the servers staging made included: only
 *                                   when staging itself is to go, not to stop it
 *
 * The web app is at staging.cubepals.com (a DNS-only CNAME in Cloudflare, so Fly issues its
 * certificate), with Google sign-in. Only STAGING_DEVELOPERS, the admin and the staging check's
 * own domain can make an account there (SIGNUP_ALLOWLIST). The API and realtime stay on fly.dev,
 * and players join `<server>.<edge address>.nip.io`. Postgres is Supabase's staging project, through
 * its session pooler (STAGING_DATABASE_URL), and mail goes to a Mailpit that only the org's private network reaches (`fly proxy 8025 -a bly-staging-mail`). Archives go to a
 * Tigris bucket. Payments are Polar's sandbox: POLAR_ACCESS_TOKEN and POLAR_PRODUCTS come from
 * .env, and `up` adds the webhook that `down` removes. What `up` generates (passwords, keys, the
 * bucket's credentials) stays in local/staging/state.json, or comes from STAGING_STATE where there
 * is no such file: a cloud environment carries it there (`env`). CLOUDFLARE_API_TOKEN,
 * AUTH_GOOGLE_CLIENT_ID, AUTH_GOOGLE_CLIENT_SECRET, STAGING_DEVELOPERS and STAGING_DATABASE_URL come
 * from the environment or local/secrets/staging.env; `up` keeps the last into the state too, for the
 * staging check.
 *
 * Needs flyctl signed in to an account in the org, and a card on the org.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createPolar } from '@polar-sh/sdk/2026-10'
import { pointCname } from './lib/cloudflare-dns.ts'

const ORG = 'blockly-staging'
const REGION = 'fra'
const APP = {
  control: 'bly-staging-control',
  realtime: 'bly-staging-realtime',
  edge: 'bly-staging-edge',
  web: 'bly-staging-web',
  mail: 'bly-staging-mail',
} as const
const PLATFORM = Object.values(APP)
const origin = (app: string) => `https://${app}.fly.dev`
const WEBHOOK_URL = `${origin(APP.control)}/api/billing/webhook`
const WEB_HOST = 'staging.cubepals.com'
const WEB = `https://${WEB_HOST}`
/** The org token the control plane creates servers with; `down` revokes every one named so. */
const TOKEN_NAME = 'bly-staging-control'
/**
 * The org token a cloud environment runs flyctl with (`env`); `down` revokes these too. Staging's
 * tokens take Fly's default life, 20 years: it has no "never", and staging outlives any test.
 */
const OPERATOR_TOKEN = 'bly-staging-operator'
const STATE_FILE = 'local/staging/state.json'
/** The staging admin: an address only the mail catcher receives for. */
const ADMIN_EMAIL = 'admin@staging.blockly.test'
/** Staging's own secrets on a maintainer's machine; a cloud environment has them in its settings. */
const SECRETS_FILE = 'local/secrets/staging.env'
/**
 * Supabase's root, which its pooler's certificate chains to, as the control image carries it.
 * node-postgres verifies the server against it (`sslmode=verify-full`).
 */
const DATABASE_CA = '/app/packages/db/certs/supabase-root-2021.crt'

interface Bucket {
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

interface State {
  /** Supabase's session pooler, `sslmode=require`: from STAGING_DATABASE_URL, which replaces it. */
  databaseUrl?: string
  authSecret: string
  ticketSecret: string
  edgeToken: string
  runtimeKey: string
  /** Made after the first staging came up: generated when missing. */
  webProxySecret?: string
  /** The org token a cloud environment runs flyctl with: made by `env`. */
  operatorToken?: string
  flyToken?: string
  bucket?: Bucket
  webhook?: { id: string; secret: string }
}

const say = (line: string) => process.stdout.write(`${line}\n`)
const secret = () => randomBytes(36).toString('base64url')

if (existsSync(SECRETS_FILE))
  for (const line of readFileSync(SECRETS_FILE, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line)
    if (match?.[1] && match[2] !== undefined) process.env[match[1]] ??= match[2]
  }

/**
 * The staging check's accounts' domain: private to staging's state, so the allowlist entry for it
 * opens nothing to anyone else. staging-check.ts derives the same one.
 */
const checkDomain = (state: State) =>
  `${createHash('sha256').update(state.authSecret).digest('hex').slice(0, 12)}.check.staging.blockly.test`

// ─── flyctl ──────────────────────────────────────────────────────────────────────────────────

/** Runs flyctl and hands back what it printed; a failure throws its last lines, never its input. */
function fly(args: string[], options: { input?: string; allowFail?: boolean } = {}): string {
  const result = Bun.spawnSync(['fly', ...args], {
    stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = result.stdout.toString()
  if (result.exitCode === 0) return out
  if (options.allowFail) return ''
  const said = `${out}\n${result.stderr.toString()}`.trim().split('\n').slice(-4).join(' | ')
  throw new Error(`fly ${args.slice(0, 3).join(' ')}: ${said}`)
}

/** A long flyctl step (a build, a deploy), shown as it happens. */
function flyLive(args: string[]): void {
  const result = Bun.spawnSync(['fly', ...args], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) throw new Error(`fly ${args.slice(0, 2).join(' ')} failed`)
}

const json = <T>(args: string[]): T => JSON.parse(fly([...args, '--json']) || 'null') as T

const appsInOrg = () =>
  (json<{ Name: string }[] | null>(['apps', 'list', '-o', ORG]) ?? []).map((a) => a.Name)

const ipsOf = (app: string) =>
  json<{ Address: string; Type: string }[] | null>(['ips', 'list', '-a', app]) ?? []

const machinesOf = (app: string) =>
  json<{ id: string; name: string; state: string; region: string }[] | null>([
    'machines',
    'list',
    '-a',
    app,
  ]) ?? []

const volumesOf = (app: string) =>
  json<{ id: string; name: string; state: string; size_gb: number }[] | null>([
    'volumes',
    'list',
    '-a',
    app,
  ]) ?? []

/** The org's Tigris buckets, by name, from flyctl's table. */
const bucketsInOrg = () =>
  fly(['storage', 'list', '-o', ORG])
    .split('\n')
    .slice(1)
    .map((line) => line.split('│')[0]?.trim() ?? '')
    .filter((name) => name !== '' && !name.startsWith('NAME'))

/** The ids of the org tokens staging made, from flyctl's table. */
const stagingTokens = () =>
  fly(['tokens', 'list', '-o', ORG])
    .split('\n')
    .map((line) => line.split('│').map((cell) => cell.trim()))
    .filter((cells) => (cells[1] === TOKEN_NAME || cells[1] === OPERATOR_TOKEN) && (cells[4] ?? '') === '')
    .map((cells) => cells[0] ?? '')
    .filter(Boolean)

// ─── State ───────────────────────────────────────────────────────────────────────────────────

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State
  // A cloud environment has no local file: its settings carry what `up` made (`env`).
  if (process.env.STAGING_STATE) return JSON.parse(process.env.STAGING_STATE) as State
  return {
    authSecret: secret(),
    ticketSecret: secret(),
    edgeToken: secret(),
    runtimeKey: `1:${secret()}`,
    webProxySecret: secret(),
  }
}

function saveState(state: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

// ─── Polar's sandbox ─────────────────────────────────────────────────────────────────────────

function polar() {
  const accessToken = process.env.POLAR_ACCESS_TOKEN
  if (!accessToken) throw new Error('POLAR_ACCESS_TOKEN (Polar sandbox) is not in .env')
  return createPolar({ accessToken, environment: 'sandbox' })
}

/**
 * The API version and events of staging's webhook: the payloads and deliveries the adapter reads
 * (infra/polar/polar-billing.ts), as production's endpoint is set (docs/production.md).
 */
const WEBHOOK = {
  api_version: '2026-10',
  events: [
    'customer.state_changed',
    'order.created',
    'order.updated',
    'order.paid',
    'order.refunded',
    'subscription.active',
    'subscription.past_due',
    'subscription.canceled',
    'subscription.uncanceled',
    'subscription.revoked',
  ],
} as const

/** Staging's webhook endpoints on the sandbox: the one `up` made, and any a failed run left. */
async function stagingWebhooks(): Promise<string[]> {
  const found: string[] = []
  for await (const endpoint of polar().webhooks.iterListWebhookEndpoints({ limit: 100 }))
    if (endpoint.url === WEBHOOK_URL) found.push(endpoint.id)
  return found
}

/**
 * Staging's webhook on the sandbox, made once; one made before keeps its secret, and is brought to
 * the version and events the adapter reads today. It is enabled again too: Polar disables an
 * endpoint whose deliveries kept failing, which they do while staging is stopped.
 */
async function pointWebhook(state: State): Promise<void> {
  if (state.webhook !== undefined) {
    const endpoint = await polar().webhooks.updateWebhookEndpoint(state.webhook.id, {
      ...WEBHOOK,
      enabled: true,
    })
    say(`  webhook ${endpoint.api_version}, ${endpoint.events.length} events, enabled: ${endpoint.enabled}`)
    return
  }
  const endpoint = await polar().webhooks.createWebhookEndpoint({
    url: WEBHOOK_URL,
    name: 'Blockly staging',
    ...WEBHOOK,
    format: 'raw',
  })
  state.webhook = { id: endpoint.id, secret: endpoint.secret }
  saveState(state)
}

/** staging.cubepals.com on the web app: Cloudflare's record for it, and Fly's certificate. */
async function pointWebDomain(): Promise<void> {
  say('domain')
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Error(`CLOUDFLARE_API_TOKEN (DNS for cubepals.com) is not in ${SECRETS_FILE}`)
  await pointCname(token, 'cubepals.com', WEB_HOST, `${APP.web}.fly.dev`)
  if (!fly(['certs', 'show', WEB_HOST, '-a', APP.web], { allowFail: true }))
    fly(['certs', 'add', WEB_HOST, '-a', APP.web])
}

/** Who can sign in and how: Google, and accounts only for the developers and the check. */
function signIn(state: State): Record<string, string> {
  const developers = (process.env.STAGING_DEVELOPERS ?? '').split(',').map((entry) => entry.trim())
  return {
    SIGNUP_ALLOWLIST: [`@${checkDomain(state)}`, ...developers].filter(Boolean).join(','),
    AUTH_GOOGLE_CLIENT_ID: process.env.AUTH_GOOGLE_CLIENT_ID ?? '',
    AUTH_GOOGLE_CLIENT_SECRET: process.env.AUTH_GOOGLE_CLIENT_SECRET ?? '',
  }
}

const webAnswers = () =>
  fetch(`${WEB}/api/health`).then(
    (response) => response.ok,
    () => false,
  )

// ─── up ──────────────────────────────────────────────────────────────────────────────────────

async function up(): Promise<void> {
  if (!process.env.POLAR_PRODUCTS)
    throw new Error('POLAR_PRODUCTS (plus:<sandbox product id>) is not in .env')
  const state = loadState()
  saveState(state)

  say('apps')
  const existing = new Set(appsInOrg())
  for (const app of PLATFORM)
    if (!existing.has(app)) {
      fly(['apps', 'create', app, '-o', ORG])
      say(`  made ${app}`)
    }

  say('database')
  state.databaseUrl = process.env.STAGING_DATABASE_URL ?? state.databaseUrl
  if (!state.databaseUrl)
    throw new Error(`STAGING_DATABASE_URL (Supabase staging, session pooler) is not in ${SECRETS_FILE}`)
  saveState(state)
  const database = new URL(state.databaseUrl)
  database.searchParams.set('sslmode', 'verify-full')
  database.searchParams.set('sslrootcert', DATABASE_CA)

  say('mail')
  if (machinesOf(APP.mail).length === 0)
    fly([
      'machine',
      'run',
      'axllent/mailpit:v1.27',
      '-a',
      APP.mail,
      '--name',
      'mailpit',
      '--region',
      REGION,
      '--vm-size',
      'shared-cpu-1x',
      '--vm-memory',
      '256',
      // The private network is IPv6; Mailpit listens on IPv4 alone unless told.
      '--env',
      'MP_SMTP_BIND_ADDR=[::]:1025',
      '--env',
      'MP_UI_BIND_ADDR=[::]:8025',
      '--env',
      'MP_SMTP_AUTH_ACCEPT_ANY=1',
      '--env',
      'MP_SMTP_AUTH_ALLOW_INSECURE=1',
      '--restart',
      'always',
    ])
  startStopped(APP.mail)

  say('archive bucket')
  if (state.bucket === undefined) {
    const name = `bly-staging-archives-${randomBytes(3).toString('hex')}`
    const said = fly(['storage', 'create', '-n', name, '-o', ORG, '-y'])
    const value = (key: string) => {
      const found = new RegExp(`${key}:\\s*(\\S+)`).exec(said)?.[1]
      if (!found) throw new Error(`fly storage create printed no ${key}`)
      return found
    }
    state.bucket = {
      name: value('BUCKET_NAME'),
      endpoint: value('AWS_ENDPOINT_URL_S3'),
      region: value('AWS_REGION'),
      accessKeyId: value('AWS_ACCESS_KEY_ID'),
      secretAccessKey: value('AWS_SECRET_ACCESS_KEY'),
    }
    saveState(state)
  }
  // Browsers put world uploads straight into the bucket, from the web app's origin.
  await s3(state.bucket).send(
    new PutBucketCorsCommand({
      Bucket: state.bucket.name,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [WEB],
            AllowedMethods: ['GET', 'PUT', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  )

  say('addresses')
  const ensureIp = (app: string, type: 'v4' | 'shared_v4' | 'v6') => {
    const have = ipsOf(app).map((ip) => ip.Type)
    const want = type === 'shared_v4' ? 'shared_v4' : type
    if (have.includes(want)) return
    if (type === 'v6') fly(['ips', 'allocate-v6', '-a', app])
    else fly(['ips', 'allocate-v4', '-a', app, '-y', ...(type === 'shared_v4' ? ['--shared'] : [])])
  }
  ensureIp(APP.edge, 'v4')
  ensureIp(APP.edge, 'v6')
  // WebTransport runs over UDP, which Fly carries on a dedicated IPv4 only; an AAAA record would
  // send browsers where it can't reach.
  ensureIp(APP.realtime, 'v4')
  for (const app of [APP.control, APP.web]) {
    ensureIp(app, 'shared_v4')
    ensureIp(app, 'v6')
  }
  const edgeV4 = ipsOf(APP.edge).find((ip) => ip.Type === 'v4')?.Address
  if (!edgeV4) throw new Error('the edge has no dedicated IPv4')
  const playDomain = `${edgeV4.replaceAll('.', '-')}.nip.io`

  await pointWebDomain()

  say('credentials')
  if (state.flyToken === undefined) {
    const made = JSON.parse(fly(['tokens', 'create', 'org', '-o', ORG, '-n', TOKEN_NAME, '-j'])) as {
      token: string
    }
    state.flyToken = made.token
    saveState(state)
  }
  await pointWebhook(state)

  if (state.webProxySecret === undefined) {
    state.webProxySecret = secret()
    saveState(state)
  }
  const webProxySecret = state.webProxySecret

  // Everything the control plane reads (docs/configuration.md), for both apps that run it.
  const config: Record<string, string> = {
    DEPLOYMENT_ID: 'staging',
    DATABASE_URL: database.toString(),
    // Three processes (api, worker, realtime), each with two pools and a listener, share the
    // pooler's limit with a deploy's migrations and the machines a rolling deploy overlaps.
    DATABASE_POOL_MAX: '5',
    WEB_CANONICAL_ORIGIN: WEB,
    ...signIn(state),
    REALTIME_PUBLIC_URL: `${origin(APP.realtime)}/`,
    REALTIME_FALLBACK_URL: `wss://${APP.realtime}.fly.dev/transport-io`,
    REALTIME_TLS_MODE: 'pinned',
    REALTIME_TLS_HOSTNAME: `${APP.realtime}.fly.dev`,
    REALTIME_TICKET_SECRET: state.ticketSecret,
    PLAY_DOMAIN: playDomain,
    PLAY_PORT: '25565',
    REGIONS: 'eu:Europe,us:North America',
    RUNTIME_PROVIDER: 'fly',
    RUNTIME_REGION_MAP: 'eu:fra,us:iad',
    FLY_ORG: ORG,
    FLY_API_TOKEN: state.flyToken,
    FLY_MACHINE_LIMIT: '50',
    // The control app runs two machines (api, worker); every other app one.
    FLY_PLATFORM_MACHINES: String(PLATFORM.length + 1),
    ARTIFACTS_RUNTIME_FACING_URL: origin(APP.control),
    ARTIFACTS_MIRROR: 'true',
    ARCHIVE_S3_ENDPOINT: state.bucket.endpoint,
    ARCHIVE_S3_BUCKET: state.bucket.name,
    ARCHIVE_S3_REGION: state.bucket.region,
    ARCHIVE_S3_ACCESS_KEY_ID: state.bucket.accessKeyId,
    ARCHIVE_S3_SECRET_ACCESS_KEY: state.bucket.secretAccessKey,
    AUTH_SECRET: state.authSecret,
    WEB_PROXY_SECRET: webProxySecret,
    ADMIN_EMAILS: ADMIN_EMAIL,
    SMTP_URL: `smtp://${APP.mail}.internal:1025`,
    MAIL_FROM: 'Cubepals Staging <hello@staging.blockly.test>',
    EDGE_TOKEN: state.edgeToken,
    RUNTIME_SECRETS_KEY: state.runtimeKey,
    POLAR_ACCESS_TOKEN: process.env.POLAR_ACCESS_TOKEN ?? '',
    POLAR_WEBHOOK_SECRET: state.webhook.secret,
    POLAR_SERVER: 'sandbox',
    POLAR_PRODUCTS: process.env.POLAR_PRODUCTS,
  }
  const lines = Object.entries(config)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')
  for (const app of [APP.control, APP.realtime])
    fly(['secrets', 'import', '-a', app, '--stage'], { input: lines })
  fly(['secrets', 'import', '-a', APP.edge, '--stage'], {
    input: `CONTROL_URL=http://api.process.${APP.control}.internal:4001\nEDGE_TOKEN=${state.edgeToken}\n`,
  })

  say('control plane (migrations run first)')
  deploy(APP.control, 'infra/fly/control.toml', 'apps/control/Dockerfile')
  say('realtime')
  deploy(APP.realtime, 'infra/fly/realtime.toml', 'apps/control/Dockerfile')
  say('edge')
  deploy(APP.edge, 'infra/fly/edge.toml', 'apps/edge/Dockerfile')
  say('web')
  // Its word about each browser's address, which the control plane believes only with this.
  fly(['secrets', 'import', '-a', APP.web, '--stage'], { input: `WEB_PROXY_SECRET=${webProxySecret}\n` })
  startStopped(APP.control) // A deploy leaves stopped machines stopped; the web build reads the API.
  deploy(APP.web, webToml(), 'apps/web/Dockerfile', [`API_UPSTREAM=${origin(APP.control)}`])
  for (const app of [APP.realtime, APP.edge, APP.web]) startStopped(app)

  await until('the web app and the API answer', 300, webAnswers)
  say('')
  status()
}

/** The web app's Fly config, written where a deploy reads it. */
function webToml(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'bly-staging-')), 'web.toml')
  writeFileSync(
    file,
    [
      `app = "${APP.web}"`,
      `primary_region = "${REGION}"`,
      // Next writes the /api rewrite at build time; server-rendered pages read it as they run.
      '[env]',
      `  API_UPSTREAM = "${origin(APP.control)}"`,
      // The browser's address as Fly's proxy saw it, sent to the control plane with the secret.
      '  WEB_CLIENT_ADDRESS_HEADER = "fly-client-ip"',
      '[http_service]',
      '  internal_port = 3000',
      '  force_https = true',
      '  auto_stop_machines = "off"',
      '  auto_start_machines = false',
      '  min_machines_running = 1',
      '[[vm]]',
      '  size = "shared-cpu-1x"',
      '  memory = "1gb"',
      '',
    ].join('\n'),
  )
  return file
}

/** Whether Depot's builders answered; once they don't, every later deploy goes to Fly's own. */
let depot = true

function deploy(app: string, config: string, dockerfile: string, buildArgs: string[] = []): void {
  const args = [
    'deploy',
    '.',
    '--config',
    config,
    '--dockerfile',
    dockerfile,
    '--app',
    app,
    '--remote-only',
    '--ha=false',
    '--yes',
    ...buildArgs.flatMap((arg) => ['--build-arg', arg]),
  ]
  try {
    flyLive(depot ? args : [...args, '--depot=false'])
  } catch (error) {
    if (!depot) throw error
    // Depot's builders speak gRPC over TLS, which a cloud environment's intercepting proxy breaks;
    // Fly's own builder comes in over WireGuard and still works there.
    depot = false
    say(`  ${app}: the deploy failed, trying again on Fly's own builder (--depot=false)`)
    flyLive([...args, '--depot=false'])
  }
  // Each role runs once on staging; the realtime role must never run twice.
  if (app === APP.realtime) fly(['scale', 'count', '1', '-a', app, '-y'])
}

async function until(what: string, seconds: number, ready: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await ready()) return
    await Bun.sleep(3000)
  }
  throw new Error(`${what}: not within ${seconds}s`)
}

const s3 = (bucket: Bucket) =>
  new S3Client({
    endpoint: bucket.endpoint,
    region: bucket.region,
    credentials: { accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey },
  })

// ─── status ──────────────────────────────────────────────────────────────────────────────────

function status(): void {
  const apps = appsInOrg()
  if (apps.length === 0) {
    say(`Nothing runs in ${ORG}.`)
    return
  }
  for (const app of apps) {
    const machines = machinesOf(app)
    const volumes = volumesOf(app)
    const ips = ipsOf(app).map((ip) => ip.Address)
    say(
      `${app.padEnd(34)} ${machines.map((m) => `${m.state}@${m.region}`).join(' ') || 'no machines'}` +
        `${volumes.length ? `  ${volumes.map((v) => `${v.size_gb} GB ${v.state}`).join(', ')}` : ''}` +
        `${ips.length ? `  ${ips.join(' ')}` : ''}`,
    )
  }
  const buckets = bucketsInOrg()
  say(`buckets: ${buckets.join(', ') || 'none'}`)
  const edgeV4 = apps.includes(APP.edge) ? ipsOf(APP.edge).find((ip) => ip.Type === 'v4')?.Address : undefined
  say('')
  say(`web:   ${WEB}`)
  if (edgeV4) say(`play:  <server>.${edgeV4.replaceAll('.', '-')}.nip.io`)
  say(`mail:  fly proxy 8025 -a ${APP.mail}, then http://localhost:8025`)
  say(`admin: sign up as ${ADMIN_EMAIL}; the confirmation arrives in that mail catcher`)
}

// ─── down ────────────────────────────────────────────────────────────────────────────────────

async function down(): Promise<void> {
  const state = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State) : null

  say('Polar sandbox webhook')
  if (process.env.POLAR_ACCESS_TOKEN)
    for (const id of await stagingWebhooks()) {
      await polar().webhooks.deleteWebhookEndpoint(id)
      say(`  removed ${id}`)
    }
  else say('  POLAR_ACCESS_TOKEN is not in .env: remove the staging endpoint on sandbox.polar.sh yourself')

  // Every app in the org, the ones the control plane made for servers included: their machines,
  // volumes and addresses go with them. The control plane goes first, so nothing it runs remakes
  // a server's app while it's being destroyed.
  say('apps')
  const order = (app: string) => (app === APP.control ? 0 : app === APP.realtime ? 1 : 2)
  for (const app of appsInOrg().sort((a, b) => order(a) - order(b))) {
    fly(['apps', 'destroy', app, '-y'])
    say(`  destroyed ${app}`)
  }

  say('buckets')
  for (const name of bucketsInOrg()) {
    if (state?.bucket?.name === name) await empty(state.bucket)
    fly(['storage', 'destroy', name, '-y'])
    say(`  destroyed ${name}`)
  }

  say('tokens')
  const tokens = stagingTokens()
  if (tokens.length > 0) {
    fly(['tokens', 'revoke', ...tokens])
    say(`  revoked ${tokens.length}`)
  }

  if (existsSync(STATE_FILE)) rmSync(STATE_FILE)

  const left = [
    ...appsInOrg().map((app) => `app ${app}`),
    ...bucketsInOrg().map((bucket) => `bucket ${bucket}`),
    ...stagingTokens().map((token) => `token ${token}`),
    ...(process.env.POLAR_ACCESS_TOKEN ? (await stagingWebhooks()).map((id) => `Polar webhook ${id}`) : []),
  ]
  say('')
  if (left.length === 0) say(`Nothing of staging is left in ${ORG} or on Polar's sandbox.`)
  else {
    say(`Still there:\n  ${left.join('\n  ')}`)
    process.exitCode = 1
  }
  // Fly keeps a destroyed volume's snapshots until their retention ends and has no call to delete
  // them sooner; they are a few cents at most.
}

/** A bucket must be empty before it's destroyed. */
async function empty(bucket: Bucket): Promise<void> {
  const client = s3(bucket)
  for (;;) {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket.name, MaxKeys: 1000 }))
    const keys = (listed.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []))
    if (keys.length === 0) return
    await client.send(new DeleteObjectsCommand({ Bucket: bucket.name, Delete: { Objects: keys } }))
  }
}

// ─── main ────────────────────────────────────────────────────────────────────────────────────

// ─── Stopped, not gone ───────────────────────────────────────────────────────────────────────

/** Stopped first, what could start a server again; then the servers; then what they all need. */
const STOP_FIRST: readonly string[] = [APP.control, APP.realtime, APP.edge, APP.web]
const STOP_LAST: readonly string[] = [APP.mail]
const stopOrder = (app: string): number =>
  STOP_FIRST.includes(app)
    ? STOP_FIRST.indexOf(app)
    : STOP_LAST.includes(app)
      ? STOP_FIRST.length + 1 + STOP_LAST.indexOf(app)
      : STOP_FIRST.length

/**
 * Every machine in the org stopped, the platform's and every server's. Volumes, the bucket,
 * secrets and the edge's and realtime's dedicated IPv4s stay, so `start` brings the platform back
 * as it was: the play domain and rt.staging's record are named after those addresses, and a cloud
 * session can't rewrite DNS. Keeping both costs about $4 a month (owner, 2026-10-09).
 */
function stop(): void {
  for (const app of appsInOrg().sort((a, b) => stopOrder(a) - stopOrder(b)))
    for (const machine of machinesOf(app)) {
      if (machine.state !== 'started' && machine.state !== 'starting') continue
      fly(['machine', 'stop', machine.id, '-a', app])
      say(`  stopped ${app} ${machine.id}`)
    }
  const running = appsInOrg().flatMap((app) =>
    machinesOf(app)
      .filter((machine) => machine.state === 'started' || machine.state === 'starting')
      .map((machine) => `${app} ${machine.id}`),
  )
  say(running.length === 0 ? `Every machine in ${ORG} is stopped.` : `Still running: ${running.join(', ')}`)
  if (running.length > 0) process.exitCode = 1
}

/** Every machine of an app that isn't running started. */
function startStopped(app: string): void {
  for (const machine of machinesOf(app)) {
    if (machine.state === 'started') continue
    fly(['machine', 'start', machine.id, '-a', app])
    say(`  started ${app} ${machine.id}`)
  }
}

/** The platform started again, the mail catcher first. Servers start when someone plays, as ever. */
async function start(): Promise<void> {
  const apps = new Set(appsInOrg())
  const missing = PLATFORM.filter((app) => !apps.has(app))
  if (missing.length > 0) {
    say(`Not made yet: ${missing.join(', ')}. Run up first.`)
    process.exitCode = 1
    return
  }
  // Without its dedicated IPv4s (an older `stop` gave them back) the play domain, named after the
  // edge's, is gone too, so taking new ones means setting the platform up again: `up`, which
  // deploys this checkout and needs CLOUDFLARE_API_TOKEN for the DNS.
  if (![APP.edge, APP.realtime].every((app) => ipsOf(app).some((ip) => ip.Type === 'v4'))) {
    say('The addresses are gone; running up to take new ones.')
    await up()
    return
  }
  for (const app of [APP.mail, APP.control, APP.realtime, APP.edge, APP.web]) startStopped(app)
  await until('the web app and the API answer', 300, webAnswers)
  // Deliveries failed while it was stopped, so Polar may have disabled the webhook.
  const state = loadState()
  if (state.webhook !== undefined && process.env.POLAR_ACCESS_TOKEN) await pointWebhook(state)
  say(`Staging is up: ${WEB}`)
}

/**
 * What a cloud environment needs to run this script, the staging check and deploys: a token to
 * drive the org with flyctl, Polar's sandbox, and everything `up` made, as STAGING_STATE. Written
 * to local/staging/cloud.env, readable only here, to paste into the environment's settings; it is
 * never printed.
 */
function env(): void {
  if (!existsSync(STATE_FILE) && !process.env.STAGING_STATE) {
    say('Nothing to hand over yet: run up first.')
    process.exitCode = 1
    return
  }
  const state = loadState()
  if (state.operatorToken === undefined) {
    const made = JSON.parse(fly(['tokens', 'create', 'org', '-o', ORG, '-n', OPERATOR_TOKEN, '-j'])) as {
      token: string
    }
    state.operatorToken = made.token
    saveState(state)
  }
  const values: Record<string, string> = {
    FLY_API_TOKEN: state.operatorToken,
    POLAR_SERVER: 'sandbox',
    POLAR_ACCESS_TOKEN: process.env.POLAR_ACCESS_TOKEN ?? '',
    POLAR_PRODUCTS: process.env.POLAR_PRODUCTS ?? '',
    STAGING_STATE: JSON.stringify(state),
  }
  const file = 'local/staging/cloud.env'
  writeFileSync(
    file,
    [
      "# Blockly staging, for a cloud environment's settings. Secrets: never commit or paste in a chat.",
      '# The environment also needs flyctl (curl -L https://fly.io/install.sh | sh) and bun.',
      ...Object.entries(values).map(([name, value]) => `${name}=${value}`),
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  const empty = Object.entries(values).filter(([, value]) => value === '')
  say(`Wrote ${file}: ${Object.keys(values).join(', ')}.`)
  if (empty.length > 0) say(`Empty, from .env: ${empty.map(([name]) => name).join(', ')}.`)
}

const command = process.argv[2]
if (command === 'up') await up()
else if (command === 'stop') stop()
else if (command === 'start') await start()
else if (command === 'status') status()
else if (command === 'env') env()
else if (command === 'down') await down()
else {
  say('bun scripts/staging.ts up | stop | start | status | env | down')
  process.exitCode = 2
}
