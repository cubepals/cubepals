import { readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, createPool, type Db } from '@blockly/db'
import { type ServerType, serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { PgBoss } from 'pg-boss'
import type { BillingService } from './app/billing/service.ts'
import { archivesMissing, type DeploymentCapabilities, supportOf } from './app/capabilities.ts'
import { RoutedCatalog } from './app/catalog/routed.ts'
import { type ControlPlane, composeControlPlane } from './app/control-plane.ts'
import { ItemIcons } from './app/items/icons.ts'
import { CLIENT_ADDRESS_HEADER } from './app/ports/auth.ts'
import type { ScheduledJob } from './app/ports/jobs.ts'
import type { PlayerProfiles, ReadinessProbe, ServerConsole } from './app/ports/minecraft.ts'
import type { BillingProvider } from './app/ports/optional.ts'
import type { LogSource } from './app/ports/platform.ts'
import type { MinecraftRuntime } from './app/ports/runtime.ts'
import { acmeCertificate, currentCertificate, publishCertificate } from './app/realtime/certificate.ts'
import { RoutedAdapters, RuntimeRouter } from './app/runtimes/router.ts'
import { presenceFor } from './app/servers/usage.ts'
import { loadConfig } from './config/load.ts'
import { ConfiguredPlayAddressing, ConfiguredRegionCatalog } from './config/play-addressing.ts'
import type { DeploymentConfig, RuntimeConfig } from './config/schema.ts'
import { longestSnapshotNeedDays } from './domain/account/entitlements.ts'
import { dollars } from './domain/policy/spend.ts'
import { AcmeIssuer } from './infra/acme/acme-issuer.ts'
import { CloudflareDns01 } from './infra/acme/cloudflare-dns01.ts'
import { assertIpv4Only } from './infra/acme/ipv4-only.ts'
import { type AuthOptions, betterAuthenticator } from './infra/auth/better-auth.ts'
import { BoatConsole, BoatLogSource, BoatProbe } from './infra/boat/boat-minecraft.ts'
import { BoatRuntime } from './infra/boat/boat-runtime.ts'
import { boatClient } from './infra/boat/client.ts'
import { BoatStarts } from './infra/boat/starts.ts'
import { CurseForgeLinks } from './infra/curseforge/curseforge-links.ts'
import { DockerLogSource } from './infra/docker/docker-logs.ts'
import { DockerRuntime } from './infra/docker/docker-runtime.ts'
import { FakeMinecraft } from './infra/fake/fake-minecraft.ts'
import { FakeRuntime, fakeHandleKey } from './infra/fake/fake-runtime.ts'
import { controlPlaneName, FleetCa } from './infra/fleet/ca.ts'
import { FleetLogSource } from './infra/fleet/fleet-logs.ts'
import { FleetRuntime } from './infra/fleet/fleet-runtime.ts'
import { NodeClient } from './infra/fleet/node-client.ts'
import { startNodeEndpoint } from './infra/fleet/node-endpoint.ts'
import { createOperatorApi } from './infra/fleet/operator-api.ts'
import { withUpgrades } from './infra/fleet/operator-upgrades.ts'
import type { RegistryOptions } from './infra/fleet/registry.ts'
import { FleetStore } from './infra/fleet/store.ts'
import { flyClient } from './infra/fly/client.ts'
import { FlyLogSource } from './infra/fly/fly-logs.ts'
import { FlyRuntime } from './infra/fly/fly-runtime.ts'
import { LibraryFileFormats } from './infra/formats/file-formats.ts'
import { LibraryPackArchives } from './infra/formats/pack-archives.ts'
import { hangarClient } from './infra/hangar/client.ts'
import { HangarCatalog } from './infra/hangar/hangar-catalog.ts'
import { MemoryLimits } from './infra/limits/memory-limits.ts'
import { UpstreamLoaderBuilds } from './infra/loaders/loader-builds.ts'
import { localCheckoutPages } from './infra/local-billing/checkout-pages.ts'
import { LocalBilling } from './infra/local-billing/local-billing.ts'
import { SmtpMailer } from './infra/mail/smtp.ts'
import { RconConsole } from './infra/mc-protocol/rcon.ts'
import { SlpProbe } from './infra/mc-protocol/slp.ts'
import { modrinthClient } from './infra/modrinth/client.ts'
import { ModrinthCatalog } from './infra/modrinth/modrinth-catalog.ts'
import { MojangClientAssets } from './infra/mojang/client-assets.ts'
import { MojangProfiles } from './infra/mojang/profiles.ts'
import { PgNotifyEventBus } from './infra/pg/events.ts'
import {
  PgBossJobs,
  startBoss,
  workArtifactMirror,
  workCuration,
  workListingEligibility,
  workPackImports,
  workSchedules,
  workServerOperations,
  workWorldDownloads,
} from './infra/pg/jobs.ts'
import { PgAdvisoryLocks } from './infra/pg/locks.ts'
import { PolarBilling } from './infra/polar/polar-billing.ts'
import { PostHogInsight } from './infra/posthog/posthog-insight.ts'
import { JoseRealtimeTickets } from './infra/realtime/jose-tickets.ts'
import { mintPinnedCertificate } from './infra/realtime/pinned-certificate.ts'
import { S3ArchiveStore } from './infra/s3/s3-archive-store.ts'
import { createBillingWebhook } from './interfaces/billing/webhook.ts'
import { createInternalApp } from './interfaces/edge/internal.ts'
import { createApiApp } from './interfaces/http/api.ts'
import { createRuntimesApi } from './interfaces/operator/runtimes.ts'
import { startRealtime } from './interfaces/realtime/server.node.ts'
import { createRuntimeApp } from './interfaces/runtime/artifacts.ts'
import type { Services } from './interfaces/trpc/trpc.ts'

/**
 * The composition root: the only file that reads configuration and constructs adapters.
 * Everything is built by hand, once, and handed to what needs it.
 */

interface ProviderAdapters {
  runtime: MinecraftRuntime
  logs: LogSource
  console: ServerConsole
  probe: ReadinessProbe
  /** What only a fleet deployment runs beside its runtime: the node endpoint, operators' API, upkeep. */
  fleet?: FleetParts
}

interface FleetParts {
  runtime: FleetRuntime
  ca: FleetCa
  registry: RegistryOptions
  thresholds: { suspectSeconds: number; unavailableSeconds: number }
  settings: Extract<RuntimeConfig, { provider: 'fleet' }>
  stop: () => void
}

/** The control plane's client certificate for calling nodes: short, and replaced every day. */
const CONTROL_PLANE_CERT_DAYS = 2

/**
 * Every runtime the deployment runs, as one (docs/runtimes.md): each built as it would be alone,
 * then the router, which hands each server's handle to the runtime that issued it, and the
 * console, probe and logs, which follow the same handle.
 */
async function runtimesFor(
  config: DeploymentConfig,
  pool: Pool,
  db: Db,
  profiles: PlayerProfiles,
): Promise<Omit<ProviderAdapters, 'runtime'> & { runtime: RuntimeRouter }> {
  const built: ProviderAdapters[] = []
  for (const runtime of config.runtimes) built.push(await providerFor(runtime, config, pool, db, profiles))
  const router = new RuntimeRouter(built.map((adapters) => adapters.runtime))
  const routed = new RoutedAdapters(
    router,
    new Map(built.map((adapters) => [adapters.runtime.provider, adapters])),
  )
  const fleet = built.find((adapters) => adapters.fleet !== undefined)?.fleet
  return {
    runtime: router,
    console: routed.console,
    probe: routed.probe,
    logs: routed.logs,
    ...(fleet === undefined ? {} : { fleet }),
  }
}

async function providerFor(
  runtime: RuntimeConfig,
  config: DeploymentConfig,
  pool: Pool,
  db: Db,
  profiles: PlayerProfiles,
): Promise<ProviderAdapters> {
  // Real servers speak RCON and answer status pings; the fake's servers answer in process.
  const minecraft = { console: new RconConsole(new PgAdvisoryLocks(pool)), probe: new SlpProbe() }
  switch (runtime.provider) {
    case 'docker':
      return {
        runtime: new DockerRuntime({
          socketPath: runtime.socketPath,
          deploymentId: config.deploymentId,
          gameNetwork: runtime.gameNetwork,
          regionMap: runtime.regionMap,
        }),
        logs: new DockerLogSource(runtime.socketPath),
        ...minecraft,
      }
    case 'fly': {
      const fly = new FlyRuntime({
        client: flyClient(runtime.apiToken),
        org: runtime.org,
        deploymentId: config.deploymentId,
        regionMap: runtime.regionMap,
        snapshotRetentionDays: longestSnapshotNeedDays(),
        machineLimit: runtime.machineLimit,
        platformMachines: runtime.platformMachines,
      })
      // Nothing is placed until every mapped region is known to exist (§8).
      await fly.checkRegions()
      return {
        runtime: fly,
        logs: new FlyLogSource({ org: runtime.org, token: runtime.apiToken, natsUrl: runtime.natsUrl }),
        ...minecraft,
      }
    }
    case 'fleet': {
      if (config.archive === null) throw new Error('RUNTIME_PROVIDER=fleet needs an archive store')
      const ca = await FleetCa.fromPem(runtime.caCertPem, runtime.caKeyPem)
      const identity = () =>
        ca.identity(controlPlaneName(config.deploymentId), 'client', CONTROL_PLANE_CERT_DAYS)
      const first = await identity()
      const nodes = new NodeClient(
        { caPem: ca.pem, certPem: first.certPem, keyPem: first.keyPem },
        config.deploymentId,
      )
      const thresholds = {
        suspectSeconds: runtime.suspectSeconds,
        unavailableSeconds: runtime.unavailableSeconds,
      }
      const fleet = new FleetRuntime({
        db,
        nodes,
        store: new FleetStore(new S3ArchiveStore(config.archive), config.deploymentId),
        deployment: config.deploymentId,
        regionMap: runtime.regionMap,
        placement: runtime.placement,
        cpuMillisPerGb: runtime.cpuMillisPerGb,
        thresholds,
      })
      const stopWatching = await fleet.watchRegistry()
      const rotation = setInterval(
        () => {
          identity()
            .then((next) => nodes.rotate({ caPem: ca.pem, certPem: next.certPem, keyPem: next.keyPem }))
            .catch((error) => console.error('fleet: kept the control plane certificate', error))
        },
        (CONTROL_PLANE_CERT_DAYS / 2) * 86_400_000,
      )
      rotation.unref()
      return {
        runtime: fleet,
        logs: new FleetLogSource(fleet, nodes),
        ...minecraft,
        fleet: {
          runtime: fleet,
          ca,
          registry: {
            deployment: config.deploymentId,
            heartbeatSeconds: runtime.heartbeatSeconds,
            leaseSeconds: runtime.leaseSeconds,
            certDays: runtime.certDays,
            renewDays: runtime.renewDays,
          },
          thresholds,
          settings: runtime,
          stop: () => {
            clearInterval(rotation)
            stopWatching()
            nodes.close()
          },
        },
      }
    }
    case 'boat': {
      const client = boatClient(runtime.apiToken, { baseUrl: runtime.apiUrl })
      const starts = new BoatStarts(client, { reserve: runtime.startReserve })
      // The key and the plan are read before anything is placed: a start refused later is a wake lost.
      const windows = await starts.windows(true)
      if (!windows.canStart) console.warn('boat: the account can start no sandboxes right now')
      const boat = new BoatRuntime({
        client,
        deploymentId: config.deploymentId,
        starts,
        runTtlSeconds: runtime.runTtlSeconds,
        regions: Object.keys(runtime.regionMap),
      })
      return {
        runtime: boat,
        logs: new BoatLogSource(boat),
        console: new BoatConsole(boat),
        probe: new BoatProbe(boat),
      }
    }
    case 'fake': {
      // The provider and its Minecraft servers live in this process: no Docker, no cloud. Their
      // state goes when the process does.
      const servers = new FakeMinecraft(profiles, fakeHandleKey)
      return {
        runtime: new FakeRuntime({
          deploymentId: config.deploymentId,
          root: join(tmpdir(), `blockly-fake-${config.deploymentId}`),
          regionMap: runtime.regionMap,
          workload: servers,
        }),
        logs: servers,
        console: servers,
        probe: servers,
      }
    }
  }
}

const hostPort = (value: string) => {
  const at = value.lastIndexOf(':')
  return { host: value.slice(0, at).replace(/^\[|\]$/g, ''), port: Number(value.slice(at + 1)) }
}

/**
 * The realtime role's certificate. A pinned one is minted here and its hash published for the
 * api role; the process leaves a day before it lapses, and its supervisor starts a fresh one.
 */
/** The longest delay a Node timer holds; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** Exits the process at a moment, however far off: a long wait is re-armed in steps. */
function exitAt(at: Date, reason: string): void {
  const wait = at.getTime() - Date.now()
  if (wait <= 0) {
    console.warn(reason)
    process.exit(0)
  }
  setTimeout(() => exitAt(at, reason), Math.min(wait, MAX_TIMER_MS)).unref()
}

async function realtimeTls(config: DeploymentConfig, db: Db): Promise<{ cert: string; privKey: string }> {
  const tls = config.realtime.tls
  if (tls.mode === 'provided') {
    return { cert: await readFile(tls.certPath, 'utf8'), privKey: await readFile(tls.keyPath, 'utf8') }
  }
  if (tls.mode === 'acme') {
    await assertIpv4Only(tls.hostname)
    const issuer = new AcmeIssuer({
      directoryUrl: tls.directoryUrl,
      email: tls.email,
      solver: new CloudflareDns01(tls.dns01),
    })
    const served = await acmeCertificate(db, issuer, {
      hostname: tls.hostname,
      secrets: config.runtimeSecrets,
    })
    if (served.issued) console.warn(`issued a realtime certificate for ${tls.hostname}`)
    // A renewal is a restart, as a pinned rotation is: the next start gets the new certificate.
    exitAt(served.renewAt, 'The realtime certificate is due for renewal; exiting so the next start renews it')
    return { cert: served.cert, privKey: served.privKey }
  }
  const minted = await mintPinnedCertificate(tls.hostname)
  await publishCertificate(db, minted.sha256, minted.expiresAt)
  // A day before it lapses, at least a minute from now.
  const due = Math.max(minted.expiresAt.getTime() - 86_400_000, Date.now() + 60_000)
  exitAt(new Date(due), 'The realtime certificate is due; exiting so a fresh one is minted')
  return minted
}

/** Better Auth as this deployment configures it, telling the application about each account. */
function authOptions(config: DeploymentConfig, db: Db, mailer: SmtpMailer, app: ControlPlane): AuthOptions {
  return {
    db,
    mailer,
    canonicalOrigin: config.web.canonicalOrigin,
    trustedOrigins: config.web.trustedOrigins,
    secret: config.auth.secret,
    cookiePrefix: config.auth.cookiePrefix,
    github: config.auth.github,
    google: config.auth.google,
    oauthProxy: config.auth.oauthProxy,
    clientAddressHeader: CLIENT_ADDRESS_HEADER,
    admitAccount: (email) => app.accounts.admits(email),
    signupAllowlist:
      config.auth.signupAllowlist.length > 0 ? [...config.auth.admins, ...config.auth.signupAllowlist] : [],
    onAccountCreated: (userId, agreement) => app.accounts.opened(userId, agreement),
    onAccount: (user) => app.accounts.configuredAdmin(user),
    onPasswordReset: (userId) => app.accounts.passwordReset(userId),
  }
}

/** What each scheduled job does here; `infra/pg/jobs.ts` says when each runs. */
function scheduledJobs(
  app: ControlPlane,
  provider: Awaited<ReturnType<typeof runtimesFor>>,
): Record<ScheduledJob, () => Promise<void>> {
  return {
    reconcile: () => app.schedules.reconcile(),
    drift: async () => {
      await app.schedules.drift()
    },
    relocations: async () => {
      const moved = await app.schedules.relocations()
      if (moved > 0) console.warn(`relocations: moved ${moved}`)
    },
    'presence-sync': () => app.schedules.presenceSync(),
    'idle-check': () => app.schedules.idleCheck(),
    'session-check': async () => {
      const stopped = await app.schedules.sessionCheck()
      if (stopped > 0) console.warn(`session-check: stopped ${stopped} at their plan's session cap`)
    },
    'disk-check': async () => {
      const grown = await app.schedules.diskCheck()
      if (grown > 0) console.warn(`disk-check: gave ${grown} more room while they ran`)
    },
    orphans: () => app.schedules.orphans(),
    'purge-sweep': () => app.schedules.purgeSweep(),
    'expiry-sweep': async () => {
      const deleted = await app.schedules.expirySweep()
      if (deleted > 0) console.warn(`expiry-sweep: deleted ${deleted} servers made for a while`)
    },
    'store-sweep': async () => {
      const queued = await app.schedules.storeSweep()
      if (queued > 0) console.warn(`store-sweep: resting ${queued} worlds nobody plays`)
    },
    'retention-sweep': async () => {
      const { warned, deleted } = await app.schedules.retentionSweep()
      if (warned + deleted > 0) console.warn(`retention-sweep: warned ${warned}, deleted ${deleted}`)
    },
    'backup-schedule': async () => {
      await app.schedules.backups()
    },
    'listing-eligibility-sweep': () => app.listings.sweep(),
    'standing-sweep': async () => {
      // Paid time that ran out with no word from the provider, audited before what it stops.
      const lapsed = await app.billing.recordLapses()
      if (lapsed > 0) console.warn(`standing: recorded ${lapsed} lapsed subscriptions`)
      const enforced = await app.accounts.enforce()
      if (enforced.stopped + enforced.closed > 0)
        console.warn(`standing: stopped ${enforced.stopped}, closed ${enforced.closed}`)
    },
    'artifact-gc': async () => {
      const collected = await app.artifacts.collectGarbage()
      if (collected.uploads + collected.blobs > 0)
        console.warn(`artifact-gc: ${collected.uploads} unfinished uploads, ${collected.blobs} unused blobs`)
    },
    // A catalog that can't be reached leaves the cache as it was; `admin-alerts` says so after 6 h.
    'catalog-refresh': async () => {
      for (const t of await app.schedules.catalogRefresh())
        console.warn(`catalog: ${t.kind} ${t.id} ${t.from ?? 'new'} → ${t.to}`)
    },
    'pack-checks': async () => {
      const checked = await app.setups.checkBrowsed()
      if (checked > 0) console.warn(`pack-checks: checked ${checked} packs of the default list`)
    },
    curation: async () => {
      const queued = await app.curation.queueDue()
      if (queued > 0) console.warn(`curation: queued ${queued} reviewed releases to check`)
    },
    'usage-close': async () => {
      const closed = await app.schedules.usageClose()
      if (closed > 0) console.warn(`usage-close: closed ${closed} power intervals left open`)
    },
    'provider-tags': async () => {
      const written = await app.fleet.tag()
      if (written > 0) console.warn(`provider-tags: tagged ${written} servers at the provider`)
    },
    // The day's figure goes to the log every pass, tripped or not (docs/money-guards.md).
    'spend-watchdog': async () => {
      const day = await app.schedules.spendCheck()
      console.warn(
        `spend-watchdog: ${day.day} ${dollars(day.cents)} of ${dollars(day.limitCents)} (compute ${dollars(day.computeCents)}, stray ${dollars(day.strayCents)} on ${day.strayMachines}, disks ${dollars(day.storageCents)}), ${day.runningServers} running`,
      )
      if (day.tripped) console.error('spend-watchdog: past the daily limit; starts and creation are now off')
      // Machines running with no running server behind them are stopped now, not at :17.
      if (day.strayMachines > 0) await app.schedules.orphans()
    },
    'admin-alerts': async () => {
      const { cleared } = await app.alerts.sweep()
      for (const key of cleared) console.warn(`admin alert cleared: ${key}`)
    },
    // What a runtime keeps tidy behind its port; only the fleet has any.
    'runtime-upkeep': async () => {
      await provider.fleet?.runtime.upkeep()
    },
    'insight-send': async () => {
      await app.insight.drain()
    },
  }
}

/** What the API's procedures may call: each one of the control plane's services. */
function apiServices(
  app: ControlPlane,
  tickets: JoseRealtimeTickets,
  capabilities: DeploymentCapabilities,
  config: DeploymentConfig,
  db: Db,
): Services {
  return {
    servers: app.servers,
    accounts: app.accounts,
    accountQueries: app.accountQueries,
    billing: app.billing,
    listings: app.listings,
    listingQueries: app.listingQueries,
    sharing: app.sharing,
    sharingQueries: app.sharingQueries,
    guestbook: app.guestbook,
    insight: app.insight,
    revisions: app.revisions,
    mods: app.mods,
    modQueries: app.modQueries,
    packs: app.packs,
    packChanges: app.packChanges,
    curation: app.curation,
    backups: app.backups,
    backupQueries: app.backupQueries,
    worlds: app.worlds,
    worldQueries: app.worldQueries,
    queries: app.queries,
    access: app.access,
    players: app.players,
    items: new ItemIcons({
      assets: new MojangClientAssets({ root: join(tmpdir(), 'blockly-client-assets') }),
    }),
    faces: app.faces,
    console: app.console,
    tickets,
    platform: { capabilities: supportOf(capabilities) },
    platformControls: app.platform,
    stuck: app.stuck,
    fleet: app.fleet,
    alerts: app.alerts,
    audit: app.audit,
    realtime: {
      url: config.realtime.publicUrl,
      fallbackUrl: config.realtime.fallbackUrl,
      certificateSha256: () =>
        config.realtime.tls.mode === 'pinned' ? currentCertificate(db) : Promise.resolve(null),
    },
  }
}

/** The worker role: every queue worked, every schedule kept, and what a deploy missed caught up. */
async function startWorker(
  boss: PgBoss,
  app: ControlPlane,
  provider: Awaited<ReturnType<typeof runtimesFor>>,
): Promise<void> {
  await workServerOperations(boss, (attempt) => app.runner.run(attempt), 8)
  await workArtifactMirror(boss, (artifact) => app.artifacts.mirror(artifact))
  await workPackImports(boss, {
    run: (id) => app.packs.runImport(id),
    gaveUp: (id, error) => app.packs.importGaveUp(id, error),
  })
  await workWorldDownloads(boss, app.backups.downloads)
  await workCuration(boss, {
    run: (release) => app.curation.ingest(release),
    gaveUp: (release, error) => app.curation.ingestGaveUp(release, error),
  })
  await workListingEligibility(boss, (serverIds) => app.listings.reevaluate(serverIds))
  await workSchedules(boss, scheduledJobs(app, provider))
  // A catalog that went unrefreshed while no worker ran is refreshed now, not at the next :41,
  // so trust uses what is true and the stale alert judges a refresh that was tried.
  if (await app.catalog.missedRefresh()) await boss.send('catalog-refresh', {})
  // The default modpack list is checked as a worker starts too, not an hour after a deploy.
  await boss.send('pack-checks', {})
  // So are the reviewed releases a deploy brought: checked now, offered once an admin says so.
  await boss.send('curation', {})
  console.warn('worker running')
}

/** Where nodes enroll and report, and the operators' API that runs the fleet. */
async function serveFleet(
  provider: { fleet?: FleetParts },
  context: {
    config: DeploymentConfig
    db: Db
    internal: Hono
    stops: Array<() => Promise<void> | void>
    app: ControlPlane
  },
): Promise<void> {
  const { config, db, internal, stops, app } = context
  const fleet = provider.fleet
  if (fleet !== undefined) {
    if (config.operatorToken === null) throw new Error('The fleet needs OPERATOR_TOKEN for its operators')
    // Nodes report and enroll here, over mutual TLS, on the private network they share with it.
    // New hosts join through it too: its certificate names the address join tokens carry.
    const { settings } = fleet
    const isIp = (name: string) => /^[0-9.]+$|:/.test(name)
    const hosts = [...new Set([...settings.endpointHosts, new URL(settings.joinUrl).hostname])]
    const endpoint = await startNodeEndpoint({
      db,
      ca: fleet.ca,
      registry: fleet.registry,
      listen: hostPort(settings.nodeListen),
      names: {
        dns: hosts.filter((name) => !isIp(name)),
        ips: hosts.filter(isIp).map((ip) => ip.replace(/^\[|\]$/g, '')),
      },
      blocklydBin: settings.blocklydBin,
      upgrades: settings.upgrades,
    })
    stops.push(() => endpoint.stop())
    // Operators' API, beside the edge's, on the internal listener only.
    const operators = createOperatorApi({
      db,
      runtime: fleet.runtime,
      thresholds: fleet.thresholds,
      token: config.operatorToken,
      relocate: async (serverId) => {
        await app.servers.relocateForPlatform(serverId, 'operator')
      },
      endpointStats: endpoint.stats,
      join: { url: settings.joinUrl, caPem: fleet.ca.pem, deployment: fleet.registry.deployment },
      regions: [...new Set(Object.values(settings.regionMap))],
    })
    internal.route('/', withUpgrades(operators, { db, release: endpoint.release }))
    console.warn(`fleet node endpoint on ${settings.nodeListen}; hosts join at ${settings.joinUrl}`)
  }
}

/** Optional capabilities: absent adapters are the capability being off (§15.4). */
/** Modrinth, and Hangar's Paper plugins beside it by the ids that name them (`catalog/routed.ts`). */
function catalogs(userAgent: string): RoutedCatalog {
  const hangar = new HangarCatalog(hangarClient(userAgent), (url) =>
    fetch(url, { headers: { 'User-Agent': userAgent } }),
  )
  return new RoutedCatalog(new ModrinthCatalog(modrinthClient(userAgent)), [hangar])
}

function capabilitiesFor(config: DeploymentConfig, db: Db): DeploymentCapabilities {
  const billing = config.billing
  return {
    insight: insightFor(config),
    archives: config.archive === null ? null : new S3ArchiveStore(config.archive),
    billing:
      billing?.provider === 'polar'
        ? new PolarBilling(billing)
        : billing?.provider === 'local'
          ? new LocalBilling({ db, secret: config.auth.secret, webOrigin: config.web.canonicalOrigin })
          : null,
  }
}

/**
 * PostHog when a token is set (app/ports/insight.ts); none sends nothing. What nothing caught,
 * unhandled rejections included, still ends the process as before: the monitor only reports it on
 * the way, as far as the queue gets before the exit.
 */
function insightFor(config: DeploymentConfig): PostHogInsight | null {
  if (config.insight === null) return null
  const insight = new PostHogInsight(config.insight)
  process.on('uncaughtExceptionMonitor', (error, origin) =>
    insight.exception(error, { properties: { route: 'process', origin } }),
  )
  return insight
}

/**
 * The billing provider's webhooks and, locally, the checkout and portal pages that stand in for
 * Polar's and deliver to them.
 */
function billingRoutes(billing: BillingService, provider: BillingProvider | null): Hono {
  const webhook = createBillingWebhook({ billing })
  const routes = new Hono().route('/', webhook)
  if (provider instanceof LocalBilling) routes.route('/', localCheckoutPages({ billing: provider, webhook }))
  return routes
}

/** What a process holds open to Postgres: the query pool, the live-update listener, the job queue. */
async function connect(config: DeploymentConfig) {
  const { url, directUrl, poolMax } = config.database
  const pool = createPool(url, poolMax)
  return {
    pool,
    db: createDb(pool),
    events: new PgNotifyEventBus(directUrl),
    boss: await startBoss(url, { maintains: config.roles.includes('worker'), poolMax }),
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  for (const note of config.local?.notes ?? []) console.warn(`local: ${note}`)
  const { pool, db, events, boss } = await connect(config)
  const profiles = new MojangProfiles()
  const provider = await runtimesFor(config, pool, db, profiles)

  const capabilities = capabilitiesFor(config, db)

  const stranded = await archivesMissing(db, capabilities)
  if (stranded !== null) console.warn(stranded)

  const mailer = new SmtpMailer(config.mail.smtpUrl, config.mail.from)
  const app = composeControlPlane(
    {
      db,
      events,
      jobs: new PgBossJobs(boss),
      limits: new MemoryLimits(),
      locks: new PgAdvisoryLocks(pool),
      runtime: provider.runtime,
      console: provider.console,
      probe: provider.probe,
      logs: provider.logs,
      profiles,
      catalog: catalogs(config.catalog.userAgent),
      loaderBuilds: new UpstreamLoaderBuilds(),
      formats: new LibraryFileFormats(),
      archives: new LibraryPackArchives(),
      curseforge: new CurseForgeLinks(),
      capabilities,
      addressing: new ConfiguredPlayAddressing(config.play),
      regions: new ConfiguredRegionCatalog(config.regions),
      mailer,
    },
    {
      defaultRuntime: config.defaultRuntime,
      runtimeSecrets: config.runtimeSecrets,
      artifactsRuntimeFacingUrl: config.artifacts.runtimeFacingUrl,
      mirrorCatalogArtifacts: config.artifacts.mirrorCatalogArtifacts,
      bootTimeouts: { runningMs: 120_000, readyMs: 10 * 60_000 },
      wakeWaitMs: 25_000,
      adminEmails: config.auth.admins,
      webOrigin: config.web.canonicalOrigin,
      signupCap: config.local === null,
    },
  )
  // The first admins come from configuration; ones it no longer lists stop being admins.
  await app.accounts.bootstrapAdmins()
  const tickets = new JoseRealtimeTickets(config.realtime.ticketSecret, config.deploymentId)

  const stops: Array<() => Promise<void> | void> = []

  if (config.roles.includes('api')) {
    const auth = betterAuthenticator(authOptions(config, db, mailer, app))
    const api = createApiApp({
      auth,
      methods: { google: config.auth.google !== null, github: config.auth.github !== null },
      addresses: { proxySecret: config.auth.proxySecret, hostHeader: config.auth.hostAddressHeader },
      origins: [config.web.canonicalOrigin, ...config.web.trustedOrigins],
      services: apiServices(app, tickets, capabilities, config, db),
    })
    // Game runtimes fetch their jars from the same public listener, under /runtime (§15.2).
    api.route('/', createRuntimeApp({ artifacts: app.artifacts }))
    // The billing provider's webhooks, reaching the same listener as the web app's /api.
    api.route('/', billingRoutes(app.billing, capabilities.billing))
    const apiServer = serve({
      fetch: api.fetch,
      hostname: hostPort(config.listen.api).host,
      port: hostPort(config.listen.api).port,
    })

    await app.waiter.start()
    const internal = createInternalApp({ edge: app.edge, token: config.edge.token })
    // Operators' API, beside the edge's, on the internal listener only: where servers run.
    if (config.operatorToken !== null)
      internal.route(
        '/',
        createRuntimesApi({
          placement: app.placement,
          economics: app.economics,
          token: config.operatorToken,
        }),
      )
    await serveFleet(provider, { config, db, internal, stops, app })
    const internalServer = serve({
      fetch: internal.fetch,
      hostname: hostPort(config.listen.internal).host,
      port: hostPort(config.listen.internal).port,
    })

    stops.push(() => closeServer(apiServer))
    stops.push(() => closeServer(internalServer))
    stops.push(() => app.waiter.stop())
    console.warn(`api on ${config.listen.api}, internal on ${config.listen.internal}`)
  }

  if (config.roles.includes('worker')) await startWorker(boss, app, provider)

  if (config.roles.includes('realtime')) {
    const realtime = await startRealtime({
      listen: hostPort(config.realtime.listen),
      fallbackListen: hostPort(config.realtime.fallbackListen),
      tls: await realtimeTls(config, db),
      allowedOrigins: [config.web.canonicalOrigin, ...config.web.trustedOrigins],
      events,
      tickets,
      console: app.feed,
      presence: async (serverId) => (await presenceFor(db, [serverId])).get(serverId) ?? [],
    })
    stops.push(() => realtime.stop())
    console.warn(`realtime on ${config.realtime.listen}, fallback on ${config.realtime.fallbackListen}`)
  }

  const shutdown = async () => {
    // Whatever still holds on by then is cut off: a stop never hangs a deploy or a reload.
    setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref()
    for (const stop of stops.reverse()) await stop()
    provider.fleet?.stop()
    await boss.stop({ graceful: true, timeout: 30_000 })
    await capabilities.insight?.shutdown()
    await events.close()
    await pool.end()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())
}

/** How long a shutdown may take before the process exits regardless. */
const SHUTDOWN_DEADLINE_MS = 45_000
/** How long requests in flight get to finish once a listener closes. */
const REQUEST_GRACE_MS = 5_000

/**
 * Stops taking connections and ends idle keep-alive ones at once, which `close` alone would wait
 * out (the edge's polls keep one open), then ends whatever is still open after a grace period.
 */
function closeServer(server: ServerType): Promise<void> {
  const http = server as Server
  return new Promise<void>((resolve) => {
    http.close(() => resolve())
    http.closeIdleConnections()
    setTimeout(() => http.closeAllConnections(), REQUEST_GRACE_MS).unref()
  })
}

await main()
