import { z } from 'zod'
import { PAID_PLANS } from '../domain/account/entitlements.ts'

/**
 * Everything a deployment can differ in. Parsed once at boot and consumed by the composition
 * root; services never see it. Domains, ports and origins all live here and nowhere else.
 */

const HostPort = z.string().regex(/^[^:]+:\d+$|^\[[0-9a-fA-F:]+\]:\d+$/, 'expected host:port')
const Hostname = z
  .string()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'expected a hostname',
  )
const Secret = z.string().min(16, 'secrets need at least 16 characters')
const RuntimeKey = z.object({ version: z.number().int().min(1), key: Secret })
const Origin = z.url().transform((u) => new URL(u).origin)

const RegionMap = z.record(z.string(), z.string())

/** An OAuth client registered with a provider, its callback at `<canonicalOrigin>/api/auth/callback/<provider>`. */
const OAuthClient = z.object({
  clientId: z.string().min(1, 'set the client id and secret together, or neither'),
  clientSecret: z.string().min(1, 'set the client id and secret together, or neither'),
})

/** One runtime a deployment runs (docs/runtimes.md); a deployment may run several at once. */
const Runtime = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('docker'),
    socketPath: z.string(),
    gameNetwork: z.string(),
    regionMap: RegionMap,
  }),
  z.object({
    provider: z.literal('fly'),
    org: z.string().min(1),
    apiToken: Secret,
    /** The org's log stream, inside its private network. */
    natsUrl: z.url(),
    regionMap: RegionMap,
    /** The organization's machine limit, and the machines the platform itself runs (§19.12). */
    machineLimit: z.number().int().positive(),
    platformMachines: z.number().int().nonnegative(),
  }),
  z.object({
    provider: z.literal('boat'),
    apiToken: Secret,
    apiUrl: z.url(),
    regionMap: RegionMap,
    /**
     * How long a running sandbox may run before Boat stops it by itself: none on a paid plan,
     * since the platform decides when a server stops; the trial allows 7200 s at most.
     */
    runTtlSeconds: z.number().int().positive().max(2_592_000).nullable(),
    /** The share of a day's Boat starts kept for starts someone asked for (docs/boat-runtime-plan.md §18). */
    startReserve: z.number().min(0).max(0.9),
  }),
  z.object({ provider: z.literal('fake'), regionMap: RegionMap }),
  /**
   * Servers on Linux machines Blockly manages itself, each running blocklyd (docs/fleet.md). One
   * machine is a fleet; more are more room. Nodes enroll with a token an operator makes.
   */
  z.object({
    provider: z.literal('fleet'),
    /** Product region → the fleet region nodes enroll into; one not listed is its own. */
    regionMap: RegionMap,
    /** The fleet CA: its certificate, and its PKCS#8 key, from the deployment's secrets. */
    caCertPem: z.string().includes('BEGIN CERTIFICATE', { message: 'FLEET_CA_CERT is a PEM certificate' }),
    caKeyPem: z.string().includes('PRIVATE KEY', { message: 'FLEET_CA_KEY is a PEM private key' }),
    /** Where the api role serves the node endpoint, on the private network nodes share with it. */
    nodeListen: HostPort,
    /** The names and addresses nodes dial the node endpoint by, for its certificate. */
    endpointHosts: z
      .array(z.string().min(1))
      .min(1, 'FLEET_ENDPOINT_HOSTS names how nodes reach the control plane'),
    /** Where new hosts reach the node endpoint to join: the URL join tokens carry. */
    joinUrl: z
      .string()
      .regex(
        /^https:\/\/[^\s'"]+$/,
        'FLEET_JOIN_URL is the https:// URL new hosts reach the node endpoint at',
      ),
    /** The static blocklyd the node endpoint hands to hosts as they join. */
    blocklydBin: z.string().min(1),
    placement: z.object({
      policy: z.enum(['balanced', 'binpack', 'spread']),
      /** Memory kept free on every node for a restore or a move to land. */
      headroomMb: z.number().int().nonnegative(),
      /**
       * How many times its memory the servers placed on a node may add up to. Only running ones
       * hold memory; 1 holds it for every placed server, sleeping or not.
       */
      memoryOvercommit: z.number().min(1),
      /** How much more CPU than a node has may be promised. */
      cpuOvercommit: z.number().positive(),
      /** Share of a node's CPU past which `balanced` prefers other nodes. */
      cpuPressure: z.number().positive().max(1),
      /** How much more disk than a node has may be promised to the worlds on it. */
      diskOvercommit: z.number().positive(),
    }),
    /** The CPU a server is counted for per GB of its memory, in thousandths of a core. */
    cpuMillisPerGb: z.number().int().positive(),
    heartbeatSeconds: z.number().int().min(1).max(60),
    /** How long after a heartbeat a node may restart, unasked, a server that failed. */
    leaseSeconds: z.number().int().min(10),
    suspectSeconds: z.number().int().positive(),
    unavailableSeconds: z.number().int().positive(),
    certDays: z.number().int().min(2).max(397),
    renewDays: z.number().int().min(1),
    /** Whether nodes on an older blocklyd are offered `blocklydBin`, one per region at a time. */
    upgrades: z
      .enum(['on', 'off'], { message: 'FLEET_UPGRADES is on or off' })
      .default('on')
      .transform((v) => v === 'on'),
  }),
])

export type RuntimeConfig = z.infer<typeof Runtime>

/** Polar, for a deployment that takes payments. */
export const PolarConfig = z.object({
  provider: z.literal('polar'),
  accessToken: Secret,
  webhookSecret: z.string().startsWith('whsec_', 'a Polar webhook secret starts with whsec_'),
  /** Named, never assumed: a default could send development traffic to real payments. */
  server: z.enum(['sandbox', 'production']),
  /** Plan key → the Polar product that sells it. */
  products: z.record(z.string(), z.string().min(1)),
})

/** Local development's stand-in for Polar (infra/local-billing): a checkout that charges nothing. */
const LocalCheckout = z.object({ provider: z.literal('local') })

export const DeploymentConfig = z.object({
  deploymentId: z.string().regex(/^[a-z0-9-]{2,16}$/),
  roles: z.array(z.enum(['api', 'worker', 'realtime'])).min(1),
  database: z.object({
    url: z.string().min(1),
    /**
     * Postgres without a pooler in between, for what a pooler breaks: the live-update listener's
     * LISTEN and the release's migrations. Fly Managed Postgres hands apps a PgBouncer URL that
     * closes a client idle for ten minutes; this is its direct one. Defaults to `url`.
     */
    directUrl: z.string().min(1),
  }),
  web: z.object({
    /** Where people reach the web app; auth's base URL is this plus /api/auth. */
    canonicalOrigin: Origin,
    /** Extra origins or patterns, such as preview deployments. */
    trustedOrigins: z.array(z.string()),
  }),
  listen: z.object({ api: HostPort, internal: HostPort }),
  realtime: z.object({
    listen: HostPort,
    publicUrl: z.url(),
    fallbackListen: HostPort,
    fallbackUrl: z.url(),
    tls: z.discriminatedUnion('mode', [
      /** Self-signed ECDSA, rotated before 14 days; the api role serves its hash. */
      z.object({ mode: z.literal('pinned'), hostname: z.string() }),
      /** A CA-issued certificate provisioned outside the process. */
      z.object({ mode: z.literal('provided'), certPath: z.string(), keyPath: z.string() }),
      /**
       * A CA-issued certificate the realtime role gets itself over ACME DNS-01 and renews, on a
       * hostname with an A record and no AAAA (§11, §19.6). Production's mode.
       */
      z.object({
        mode: z.literal('acme'),
        hostname: Hostname,
        directoryUrl: z.url(),
        email: z.email(),
        /** The operator accepts the CA's terms of service; nothing accepts them by default. */
        agreeTos: z.literal(true, 'set ACME_AGREE_TOS=true to accept the certificate authority’s terms'),
        dns01: z.discriminatedUnion('provider', [
          z.object({ provider: z.literal('cloudflare'), apiToken: Secret, zoneId: z.string().min(1) }),
        ]),
      }),
    ]),
    ticketSecret: Secret,
  }),
  play: z.object({
    domain: Hostname,
    aliases: z.array(Hostname),
    port: z.number().int().min(1).max(65535),
  }),
  regions: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) })).min(1),
  auth: z.object({
    secret: Secret,
    cookiePrefix: z.string().regex(/^[a-z0-9-]+$/),
    github: OAuthClient.nullable(),
    google: OAuthClient.nullable(),
    /** Verified emails that are platform admins; the first admins come from here. */
    admins: z.array(z.email()),
    /**
     * When it lists anything, only these addresses, and addresses at any `@domain` it lists, can
     * make an account, by email or a provider; admins always can. Staging lists its developers.
     * Empty, anyone can.
     */
    signupAllowlist: z.array(z.string().regex(/^[^@\s]*@[^@\s]+$/)),
    /**
     * Preview deployments sign in with Google through this environment's canonical origin, the
     * only callback its OAuth apps register (§14). The secret encrypts what passes between them;
     * each environment has its own. Absent, previews sign in with email only.
     */
    oauthProxy: z.object({ secret: Secret }).nullable(),
    /**
     * The web tier sends each browser's address with this secret, and the control plane takes its
     * word only then: sign-in's limits count each address. Absent, only the host's own header is.
     */
    proxySecret: Secret.nullable(),
    /** A client-address header the host's proxy sets and overwrites: `fly-client-ip` on Fly. */
    hostAddressHeader: z.string().nullable(),
  }),
  mail: z.object({ smtpUrl: z.string().min(1), from: z.string().min(3) }),
  edge: z.object({ token: Secret }),
  /** The runtime keyring: the current key and version, and earlier ones still accepted. */
  runtimeSecrets: z
    .object({ current: RuntimeKey, previous: z.array(RuntimeKey) })
    .superRefine((ring, ctx) => {
      const versions = ring.previous.map((k) => k.version)
      if (versions.some((version) => version >= ring.current.version))
        ctx.addIssue({
          code: 'custom',
          message: "RUNTIME_SECRETS_PREVIOUS_KEYS holds only versions older than RUNTIME_SECRETS_KEY's",
        })
      if (new Set(versions).size !== versions.length)
        ctx.addIssue({ code: 'custom', message: 'RUNTIME_SECRETS_PREVIOUS_KEYS names each version once' })
    }),
  /** Every runtime the deployment runs, each once. */
  runtimes: z.array(Runtime).min(1),
  /** Where new servers go unless a placement rule sends them elsewhere: one of `runtimes`. */
  defaultRuntime: z.string().min(1),
  /** The operators' API's bearer token (scripts/runtimes.ts, scripts/fleet.ts); none turns it off. */
  operatorToken: Secret.nullable(),
  artifacts: z.object({
    /** The control plane as game runtimes reach it (§15.2). */
    runtimeFacingUrl: z.url(),
    mirrorCatalogArtifacts: z.boolean(),
  }),
  catalog: z.object({
    /** Modrinth refuses traffic that doesn't name its application, and Hangar asks for it; this names the deployment. */
    userAgent: z.string().min(1),
  }),
  /** Absent means this deployment has no archives capability (§15.4). */
  archive: z
    .object({
      endpoint: z.url(),
      /** How game runtimes reach the store, when they call it by another name (local Docker). */
      runtimeEndpoint: z.url().nullable(),
      bucket: z.string().min(1),
      region: z.string().min(1),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
    })
    .nullable(),
  /**
   * PostHog (app/ports/insight.ts): the project's public token and its host. Absent sends nothing.
   * `environment` rides on every event, so staging's and local ones are kept out of production's.
   */
  insight: z
    .object({
      token: z.string().startsWith('phc_', 'POSTHOG_TOKEN is a PostHog project token, phc_…'),
      host: z.url(),
      environment: z.enum(['production', 'staging', 'development']),
    })
    .nullable(),
  /** Absent means entitlements come from the plan column alone (§15.4). */
  billing: z.discriminatedUnion('provider', [PolarConfig, LocalCheckout]).nullable(),
  /**
   * Local development (config/local.ts): what stands in here for an outside service, one line
   * each for the log. Null on every deployment.
   */
  local: z.object({ notes: z.array(z.string()) }).nullable(),
})

export type DeploymentConfig = z.infer<typeof DeploymentConfig>

export const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]'

/**
 * This machine, or an address on its own local network (RFC 1918, and link-local): where the
 * dev stack runs for the phone on the same Wi-Fi (`bun run dev:lan`). No deployment anyone else
 * uses is served from one, so plain http stays refused everywhere that matters.
 */
export const isLocal = (host: string) => {
  if (isLoopback(host)) return true
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false
  const [a = -1, b = -1] = octets
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/** How .env.example's secrets start: values anyone can read, for local development only. */
export const LOCAL_ONLY = 'local-only-'

/** Consistency checks a schema cannot express. Each returns a sentence naming the fix. */
export function inconsistencies(config: DeploymentConfig): string[] {
  const problems: string[] = []
  const playDomains = [config.play.domain, ...config.play.aliases]
  const platformHosts = [
    new URL(config.web.canonicalOrigin).hostname,
    new URL(config.realtime.publicUrl).hostname,
    new URL(config.realtime.fallbackUrl).hostname,
  ]
  for (const host of platformHosts) {
    for (const domain of playDomains) {
      if (host.endsWith(`.${domain}`))
        problems.push(
          `${host} sits under the play domain ${domain}; a server slug could shadow it. Move it elsewhere.`,
        )
    }
  }
  const providers = config.runtimes.map((runtime) => runtime.provider)
  if (new Set(providers).size !== providers.length)
    problems.push(`RUNTIME_PROVIDERS names a runtime twice (${providers.join(', ')}).`)
  const fallback = config.runtimes.find((runtime) => runtime.provider === config.defaultRuntime)
  if (fallback === undefined)
    problems.push(
      `RUNTIME_PROVIDER is ${config.defaultRuntime}, which RUNTIME_PROVIDERS doesn't list (${providers.join(', ')}).`,
    )
  // Any new server may go to the default runtime, so it places every region; others may place some.
  for (const region of config.regions) {
    if (fallback !== undefined && !(region.key in fallback.regionMap))
      problems.push(
        `Region "${region.key}" has no placement on the default runtime, ${fallback.provider}. Add it to its region map.`,
      )
  }
  // Another runtime places only the regions its own map names; RUNTIME_REGION_MAP is the default's.
  for (const runtime of config.runtimes)
    if (runtime.provider !== config.defaultRuntime && Object.keys(runtime.regionMap).length === 0)
      problems.push(
        `${runtime.provider} runs beside the default runtime, ${config.defaultRuntime}, and places only the regions its own map names. Set ${runtime.provider.toUpperCase()}_REGION_MAP.`,
      )
  const web = new URL(config.web.canonicalOrigin)
  if (web.protocol !== 'https:' && !isLocal(web.hostname))
    problems.push(`The web origin ${web.origin} must use https outside local development.`)
  for (const runtime of config.runtimes) {
    // Two machines a server at their busiest (restore, export, relocate), beside the platform's own:
    // the Fly runtime counts its ceiling the same way (MACHINES_PER_SERVER in infra/fly).
    if (runtime.provider === 'fly' && runtime.machineLimit - runtime.platformMachines < 2)
      problems.push(
        `FLY_MACHINE_LIMIT (${runtime.machineLimit}) leaves no room for a server beside the platform's ${runtime.platformMachines} machines.`,
      )
    // Docker runs every server on this one machine, so a second region would be a label, not a place.
    // Local development may name several, all on this machine, to try what more than one region
    // changes (the create page's picker, a move); nobody plays there who would be told a place.
    const places = runtime === fallback ? config.regions.length : Object.keys(runtime.regionMap).length
    if (runtime.provider === 'docker' && !isLocal(web.hostname) && places > 1)
      problems.push(
        `RUNTIME_PROVIDER=docker runs every server on this machine, so it has one region; REGIONS lists ${config.regions.length}.`,
      )
    if (runtime.provider === 'fleet') {
      // Copies of worlds outlive their nodes only in the archive store: no store, no moves or rebuilds.
      if (config.archive === null)
        problems.push(
          'RUNTIME_PROVIDER=fleet keeps copies of worlds off their machines in the archive store. Configure one (ARCHIVE_*).',
        )
      if (config.operatorToken === null)
        problems.push('The fleet is operated through the operators’ API. Set OPERATOR_TOKEN.')
      if (
        runtime.suspectSeconds <= runtime.heartbeatSeconds * 2 ||
        runtime.unavailableSeconds <= runtime.suspectSeconds
      )
        problems.push(
          'FLEET_SUSPECT_SECONDS must be more than two heartbeats, and FLEET_UNAVAILABLE_SECONDS more than it.',
        )
      if (runtime.leaseSeconds <= runtime.heartbeatSeconds * 3)
        problems.push('FLEET_LEASE_SECONDS must outlast three heartbeats, or a node loses it between them.')
      if (runtime.renewDays >= runtime.certDays)
        problems.push(
          'FLEET_RENEW_DAYS must be less than FLEET_NODE_CERT_DAYS, or certificates renew at once.',
        )
    }
    // The fake runtime keeps servers in this process's memory: for tests and local runs only.
    if (runtime.provider === 'fake' && !isLoopback(web.hostname))
      problems.push(
        `RUNTIME_PROVIDER=fake runs no real servers and forgets them on restart; ${web.origin} is a deployed origin. Use docker or fly.`,
      )
  }
  // A trusted pattern names the project and team: `*.vercel.app` would trust anyone's preview.
  for (const pattern of config.web.trustedOrigins) {
    const [first = '', ...rest] = pattern.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('.')
    if (first === '*' || rest.some((label) => label.includes('*')))
      problems.push(
        `WEB_TRUSTED_ORIGINS trusts every site matching ${pattern}. Name the project and team, as in https://blockly-*-<team>.vercel.app.`,
      )
  }
  if (config.billing?.provider === 'polar') {
    const sold = Object.keys(config.billing.products)
    for (const plan of sold)
      if (!PAID_PLANS.includes(plan))
        problems.push(`POLAR_PRODUCTS sells "${plan}", which isn't a paid plan (${PAID_PLANS.join(', ')}).`)
    for (const plan of PAID_PLANS)
      if (!sold.includes(plan))
        problems.push(`No Polar product sells the ${plan} plan. Add it to POLAR_PRODUCTS.`)
  }
  if (config.artifacts.mirrorCatalogArtifacts && config.archive === null)
    problems.push('Mirroring catalog artifacts needs an archive store. Configure one or turn mirroring off.')
  // The certificate names what browsers dial.
  const tls = config.realtime.tls
  if (tls.mode === 'acme' && new URL(config.realtime.publicUrl).hostname !== tls.hostname)
    problems.push(
      `REALTIME_PUBLIC_URL dials ${new URL(config.realtime.publicUrl).hostname}, but the ACME certificate is for ${tls.hostname}. Use one hostname for both.`,
    )
  // TCP falls back from ::1 to 127.0.0.1; WebTransport runs over UDP and Chrome does not.
  const realtime = new URL(config.realtime.publicUrl)
  const realtimeListenHost = config.realtime.listen.slice(0, config.realtime.listen.lastIndexOf(':'))
  if (realtime.hostname === 'localhost' && realtimeListenHost === '127.0.0.1')
    problems.push(
      `Browsers reach localhost over IPv6 first and WebTransport does not fall back, so ${realtime.origin} cannot reach a listener on 127.0.0.1. Publish https://127.0.0.1:${realtime.port}/ instead.`,
    )
  // Fly rewrites a UDP packet's address and never its port (docs.fly.io/networking/udp-and-tcp):
  // what browsers dial is the port the listener has to be on.
  const realtimeListenPort = Number(config.realtime.listen.slice(config.realtime.listen.lastIndexOf(':') + 1))
  const dialledPort = Number(realtime.port || 443)
  if (realtimeListenHost === 'fly-global-services' && realtimeListenPort !== dialledPort)
    problems.push(
      `Fly delivers UDP to the port it was sent to, so WebTransport dialled at ${realtime.origin} arrives on port ${dialledPort}, never at ${config.realtime.listen}. Listen on fly-global-services:${dialledPort}.`,
    )
  return problems
}
