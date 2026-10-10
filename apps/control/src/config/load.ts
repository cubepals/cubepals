// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { isLocalDeployment, localBilling, localNotes, localOnly } from './local.ts'
import { DeploymentConfig, inconsistencies } from './schema.ts'

/** Reads the environment into a DeploymentConfig, or exits with every problem at once. */

/** A runtime key and its version: `2:<key>`, or a bare key, which is version 1. */
function versionedKey(value: string | undefined): { version: number; key: string } {
  const match = /^(\d+):(.+)$/.exec(value ?? '')
  return match ? { version: Number(match[1]), key: match[2] ?? '' } : { version: 1, key: value ?? '' }
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** "key:Label, other:Other label" → [{ key, label }] */
const pairs = (value: string | undefined) =>
  list(value).map((item) => {
    const at = item.indexOf(':')
    return at < 0
      ? { key: item, label: item }
      : { key: item.slice(0, at).trim(), label: item.slice(at + 1).trim() }
  })

const record = (value: string | undefined) =>
  Object.fromEntries(pairs(value).map(({ key, label }) => [key, label]))

/** A PEM as a secret store holds it: with its line breaks, or with them written as `\n`. */
const pem = (value: string | undefined) => value?.replace(/\\n/g, '\n')

/** Let's Encrypt's production directory; staging and tests point ACME_DIRECTORY_URL elsewhere. */
const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory'

/** Where the node endpoint listens by default: every address, IPv6 and IPv4 alike. */
const NODE_LISTEN = '[::]:8443'

/**
 * How new hosts join the fleet (docs/fleet-operations.md, "Adding a node"): FLEET_JOIN_URL, by
 * default the first of FLEET_ENDPOINT_HOSTS at FLEET_NODE_LISTEN's port, and the blocklyd the node
 * endpoint hands them, by default the one the control plane's image carries (its Dockerfile).
 */
function fleetJoin(env: NodeJS.ProcessEnv): { joinUrl: string; blocklydBin: string } {
  const host = list(env.FLEET_ENDPOINT_HOSTS)[0]
  const port = (env.FLEET_NODE_LISTEN ?? NODE_LISTEN).split(':').at(-1)
  const named = host?.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return {
    joinUrl: env.FLEET_JOIN_URL || (named === undefined ? '' : `https://${named}:${port}`),
    blocklydBin: env.FLEET_BLOCKLYD_BIN || '/usr/local/lib/blocklyd/blocklyd',
  }
}

/** PostHog's EU cloud, where the project lives; POSTHOG_HOST points elsewhere. */
const POSTHOG_EU = 'https://eu.i.posthog.com'

/** Which environment a deployment is, by its own id: production's and staging's, and anything else. */
const environmentOf = (deploymentId: string | undefined) =>
  deploymentId === 'prod' ? 'production' : deploymentId === 'staging' ? 'staging' : 'development'

/** The SMTP server and sender; staging's subjects say they are staging's, by the deployment's own id. */
const mailFrom = (env: NodeJS.ProcessEnv) => ({
  smtpUrl: env.SMTP_URL,
  from: env.MAIL_FROM,
  subjectPrefix: environmentOf(env.DEPLOYMENT_ID) === 'staging' ? '[Staging] ' : '',
})

/** Postgres: one URL, or a pooled one and a direct one past it, and what each pool may hold. */
const databaseFrom = (env: NodeJS.ProcessEnv) => ({
  url: env.DATABASE_URL,
  directUrl: env.DATABASE_DIRECT_URL ?? env.DATABASE_URL,
  poolMax: Number(env.DATABASE_POOL_MAX ?? 10),
})

/** PostHog with its token, and the environment every event says it came from; none without one. */
const insightFrom = (env: NodeJS.ProcessEnv) =>
  env.POSTHOG_TOKEN
    ? {
        token: env.POSTHOG_TOKEN,
        host: env.POSTHOG_HOST || POSTHOG_EU,
        environment: environmentOf(env.DEPLOYMENT_ID),
      }
    : null

/** Neither set means the provider is off; one without the other fails validation by name. */
const oauthClient = (clientId: string | undefined, clientSecret: string | undefined) =>
  clientId || clientSecret ? { clientId: clientId ?? '', clientSecret: clientSecret ?? '' } : null

/**
 * One runtime's settings, from its own variables. Its region map is `<NAME>_REGION_MAP`. The
 * default runtime's may be RUNTIME_REGION_MAP instead, which a deployment running one runtime
 * sets; another runtime never borrows it, since it would claim regions it doesn't serve.
 */
function runtimeFrom(provider: string, env: NodeJS.ProcessEnv, isDefault: boolean): unknown {
  const own = env[`${provider.toUpperCase()}_REGION_MAP`]
  const regionMap = record(isDefault ? (own ?? env.RUNTIME_REGION_MAP) : own)
  switch (provider) {
    case 'fly':
      return {
        provider,
        org: env.FLY_ORG,
        apiToken: env.FLY_API_TOKEN,
        natsUrl: env.FLY_NATS_URL ?? 'nats://[fdaa::3]:4223',
        regionMap,
        // Fly's default for an organization is about 50 (docs/research); Terraform sets both.
        machineLimit: Number(env.FLY_MACHINE_LIMIT ?? 50),
        platformMachines: Number(env.FLY_PLATFORM_MACHINES ?? 4),
      }
    case 'boat':
      return {
        provider,
        apiToken: env.BOAT_API_TOKEN,
        apiUrl: env.BOAT_API_URL ?? 'https://boat.dev/api/v1',
        regionMap,
        runTtlSeconds: env.BOAT_RUN_TTL_SECONDS ? Number(env.BOAT_RUN_TTL_SECONDS) : null,
        startReserve: Number(env.BOAT_START_RESERVE ?? 0.1),
      }
    case 'fake':
      return { provider, regionMap }
    case 'fleet':
      return {
        provider,
        regionMap,
        caCertPem: pem(env.FLEET_CA_CERT),
        caKeyPem: pem(env.FLEET_CA_KEY),
        // Every address, IPv6 and IPv4 alike: Fly's private network, where nodes reach it, is IPv6.
        nodeListen: env.FLEET_NODE_LISTEN ?? NODE_LISTEN,
        endpointHosts: list(env.FLEET_ENDPOINT_HOSTS),
        ...fleetJoin(env),
        placement: {
          policy: env.FLEET_PLACEMENT ?? 'balanced',
          headroomMb: Number(env.FLEET_HEADROOM_MB ?? 0),
          // Plans let a server run 3–8% of a month, so few of a node's servers run at once.
          memoryOvercommit: Number(env.FLEET_MEMORY_OVERCOMMIT ?? 4),
          cpuOvercommit: Number(env.FLEET_CPU_OVERCOMMIT ?? 1),
          cpuPressure: Number(env.FLEET_CPU_PRESSURE ?? 0.8),
          diskOvercommit: Number(env.FLEET_DISK_OVERCOMMIT ?? 1),
        },
        // A busy 3 GB server's game thread is most of a core; idle ones use little of theirs.
        cpuMillisPerGb: Number(env.FLEET_CPU_MILLIS_PER_GB ?? 250),
        heartbeatSeconds: Number(env.FLEET_HEARTBEAT_SECONDS ?? 5),
        leaseSeconds: Number(env.FLEET_LEASE_SECONDS ?? 120),
        suspectSeconds: Number(env.FLEET_SUSPECT_SECONDS ?? 15),
        unavailableSeconds: Number(env.FLEET_UNAVAILABLE_SECONDS ?? 45),
        certDays: Number(env.FLEET_NODE_CERT_DAYS ?? 30),
        renewDays: Number(env.FLEET_RENEW_DAYS ?? 10),
        // Nodes on an older blocklyd are offered this image's, one per region at a time.
        upgrades: env.FLEET_UPGRADES,
      }
    case 'docker':
      return {
        provider,
        socketPath: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
        gameNetwork: env.DOCKER_GAME_NETWORK ?? 'blockly-games',
        regionMap,
      }
    default:
      // Left for the schema to refuse by name.
      return { provider, regionMap }
  }
}

/**
 * Billing, and what stands in for outside services in local development (config/local.ts). There,
 * it is the local checkout unless LOCAL_BILLING=polar asks for Polar; a deployment has billing exactly
 * when it has Polar's token, and is refused if the rest is wrong.
 */
function billingFrom(env: NodeJS.ProcessEnv): { billing: unknown; local: { notes: string[] } | null } {
  const polar =
    env.POLAR_ACCESS_TOKEN || env.POLAR_WEBHOOK_SECRET || env.POLAR_PRODUCTS
      ? {
          provider: 'polar',
          accessToken: env.POLAR_ACCESS_TOKEN,
          webhookSecret: env.POLAR_WEBHOOK_SECRET,
          server: env.POLAR_SERVER,
          products: record(env.POLAR_PRODUCTS),
        }
      : null
  if (!isLocalDeployment(env)) return { billing: env.POLAR_ACCESS_TOKEN ? polar : null, local: null }
  const { billing, note } = localBilling(polar, env.LOCAL_BILLING)
  return { billing, local: { notes: [note, ...localNotes(env)] } }
}

export function configFromEnv(env: NodeJS.ProcessEnv): unknown {
  // The default runtime, where new servers go; RUNTIME_PROVIDERS lists every runtime the
  // deployment runs at once (docs/runtimes.md), the default among them.
  const defaultRuntime = env.RUNTIME_PROVIDER ?? 'docker'
  const providers = list(env.RUNTIME_PROVIDERS)
  const runtimes = (providers.length === 0 ? [defaultRuntime] : providers).map((provider) =>
    runtimeFrom(provider, env, provider === defaultRuntime),
  )

  const tls =
    env.REALTIME_TLS_MODE === 'provided'
      ? { mode: 'provided', certPath: env.REALTIME_TLS_CERT, keyPath: env.REALTIME_TLS_KEY }
      : env.REALTIME_TLS_MODE === 'acme'
        ? {
            mode: 'acme',
            hostname: env.REALTIME_TLS_HOSTNAME,
            directoryUrl: env.ACME_DIRECTORY_URL ?? LETS_ENCRYPT,
            email: env.ACME_EMAIL,
            agreeTos: env.ACME_AGREE_TOS === 'true',
            dns01: {
              provider: env.ACME_DNS_PROVIDER ?? 'cloudflare',
              apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
              zoneId: env.CLOUDFLARE_ZONE_ID,
            },
          }
        : { mode: 'pinned', hostname: env.REALTIME_TLS_HOSTNAME ?? 'localhost' }

  return {
    deploymentId: env.DEPLOYMENT_ID,
    roles: list(env.ROLES ?? 'api,worker,realtime'),
    database: databaseFrom(env),
    web: { canonicalOrigin: env.WEB_CANONICAL_ORIGIN, trustedOrigins: list(env.WEB_TRUSTED_ORIGINS) },
    listen: { api: env.API_LISTEN ?? '127.0.0.1:4000', internal: env.INTERNAL_LISTEN ?? '127.0.0.1:4001' },
    realtime: {
      listen: env.REALTIME_LISTEN ?? '127.0.0.1:7443',
      publicUrl: env.REALTIME_PUBLIC_URL,
      fallbackListen: env.REALTIME_FALLBACK_LISTEN ?? '127.0.0.1:7444',
      fallbackUrl: env.REALTIME_FALLBACK_URL,
      tls,
      ticketSecret: env.REALTIME_TICKET_SECRET,
    },
    play: {
      domain: env.PLAY_DOMAIN,
      aliases: list(env.PLAY_DOMAIN_ALIASES),
      port: Number(env.PLAY_PORT ?? '25565'),
    },
    regions: pairs(env.REGIONS),
    auth: {
      secret: env.AUTH_SECRET,
      cookiePrefix: `blockly-${env.DEPLOYMENT_ID ?? 'unknown'}`,
      github: oauthClient(env.AUTH_GITHUB_CLIENT_ID, env.AUTH_GITHUB_CLIENT_SECRET),
      google: oauthClient(env.AUTH_GOOGLE_CLIENT_ID, env.AUTH_GOOGLE_CLIENT_SECRET),
      admins: list(env.ADMIN_EMAILS).map((email) => email.toLowerCase()),
      signupAllowlist: list(env.SIGNUP_ALLOWLIST).map((entry) => entry.toLowerCase()),
      oauthProxy: env.AUTH_OAUTH_PROXY_SECRET ? { secret: env.AUTH_OAUTH_PROXY_SECRET } : null,
      proxySecret: env.WEB_PROXY_SECRET || null,
      // Fly names the app on every machine it runs, and its proxy sets this header on every request.
      hostAddressHeader: env.FLY_APP_NAME ? 'fly-client-ip' : null,
    },
    mail: mailFrom(env),
    edge: { token: env.EDGE_TOKEN },
    // `version:key`, or a bare key as version 1; earlier keys a rotation still accepts, comma-separated.
    runtimeSecrets: {
      current: versionedKey(env.RUNTIME_SECRETS_KEY),
      previous: list(env.RUNTIME_SECRETS_PREVIOUS_KEYS).map(versionedKey),
    },
    runtimes,
    defaultRuntime,
    // Operators' API on the internal listener (scripts/runtimes.ts, scripts/fleet.ts).
    operatorToken: env.OPERATOR_TOKEN || env.FLEET_OPERATOR_TOKEN || null,
    artifacts: {
      runtimeFacingUrl: env.ARTIFACTS_RUNTIME_FACING_URL,
      mirrorCatalogArtifacts: env.ARTIFACTS_MIRROR === 'true',
    },
    catalog: {
      userAgent:
        env.CATALOG_USER_AGENT ||
        `blockly-control/${env.DEPLOYMENT_ID} (+https://github.com/cubepals/cubepals)`,
    },
    archive: env.ARCHIVE_S3_ENDPOINT
      ? {
          endpoint: env.ARCHIVE_S3_ENDPOINT,
          runtimeEndpoint: env.ARCHIVE_S3_RUNTIME_ENDPOINT || null,
          bucket: env.ARCHIVE_S3_BUCKET,
          region: env.ARCHIVE_S3_REGION ?? 'auto',
          accessKeyId: env.ARCHIVE_S3_ACCESS_KEY_ID,
          secretAccessKey: env.ARCHIVE_S3_SECRET_ACCESS_KEY,
        }
      : null,
    insight: insightFrom(env),
    ...billingFrom(env),
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const parsed = DeploymentConfig.safeParse(configFromEnv(env))
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`The deployment configuration is invalid:\n${lines.join('\n')}`)
  }
  const problems = [...inconsistencies(parsed.data), ...localOnly(parsed.data)]
  if (problems.length > 0)
    throw new Error(`The deployment configuration is inconsistent:\n  ${problems.join('\n  ')}`)
  return parsed.data
}
