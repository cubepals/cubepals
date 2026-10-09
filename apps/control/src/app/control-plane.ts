import type { Db } from '@blockly/db'
import { PlayerFaces } from './access/faces.ts'
import { AccessReconciler } from './access/reconciler.ts'
import { AccessService } from './access/service.ts'
import { AccountQueries } from './accounts/queries.ts'
import { AccountService } from './accounts/service.ts'
import { ArtifactLinks } from './artifacts/links.ts'
import { ArtifactService } from './artifacts/service.ts'
import { BackupQueries } from './backups/queries.ts'
import { BackupService } from './backups/service.ts'
import { BillingService } from './billing/service.ts'
import type { DeploymentCapabilities } from './capabilities.ts'
import { CatalogSync } from './catalog/sync.ts'
import { ConsoleFeed } from './console/feed.ts'
import { ConsoleService } from './console/service.ts'
import type { OwnPack } from './curation/own.ts'
import type { CuratedPack } from './curation/packs.ts'
import { PackCuration } from './curation/service.ts'
import { EdgeService } from './edge/service.ts'
import { GuestbookService } from './guestbook/service.ts'
import { InsightService } from './insight/service.ts'
import { ListingQueries } from './listings/queries.ts'
import { ListingService } from './listings/service.ts'
import { ModQueries } from './mods/queries.ts'
import { ModService } from './mods/service.ts'
import { BootSequence, type BootTimeouts } from './operations/boot.ts'
import { createHandlers } from './operations/handlers.ts'
import { OperationRunner } from './operations/runner.ts'
import { Schedules } from './operations/schedules.ts'
import { PackBuilder } from './packs/build.ts'
import { PackChanges } from './packs/changes.ts'
import { PackContents } from './packs/contents.ts'
import { PackService } from './packs/service.ts'
import { PlatformAlerts } from './platform/alerts.ts'
import { AuditQueries } from './platform/audit.ts'
import { PlatformControlsService } from './platform/controls.ts'
import { Fleet } from './platform/fleet.ts'
import { StuckWork } from './platform/stuck.ts'
import { PlayerService } from './players/service.ts'
import { AccessPolicy } from './policy/access-policy.ts'
import type { ModCatalog } from './ports/catalog.ts'
import type { CurseForge } from './ports/curseforge.ts'
import type { EventBus } from './ports/events.ts'
import type { FileFormats, PackArchives } from './ports/formats.ts'
import type { JobQueue } from './ports/jobs.ts'
import type { Limits } from './ports/limits.ts'
import type { LoaderBuilds } from './ports/loaders.ts'
import type { Locks } from './ports/locks.ts'
import type { PlayerProfiles, ReadinessProbe, ServerConsole } from './ports/minecraft.ts'
import type { LogSource, Mailer, PlayAddressing, RegionCatalog } from './ports/platform.ts'
import { RevisionService } from './revisions/service.ts'
import { RuntimeEconomics } from './runtimes/economics.ts'
import type { Runtimes } from './runtimes/router.ts'
import { RuntimePlacement } from './runtimes/service.ts'
import type { SecretKeyring } from './secrets.ts'
import { ServerQueries } from './servers/queries.ts'
import { MinecraftServerService } from './servers/service.ts'
import { RuntimeSpecs } from './servers/specs.ts'
import { ServerTransitions } from './servers/transitions.ts'
import { ServerWaiter } from './servers/waiter.ts'
import { SetupService } from './setups/service.ts'
import { SharingQueries } from './sharing/queries.ts'
import { SharingService } from './sharing/service.ts'
import { WorldQueries } from './worlds/queries.ts'
import { WorldService } from './worlds/service.ts'

/** Everything outside the application that it talks to, as ports. */
export interface ControlPlanePorts {
  db: Db
  events: EventBus
  jobs: JobQueue
  /** Mutual exclusion across every control-plane process. */
  locks: Locks
  /**
   * Every runtime the deployment runs, as one (app/runtimes/router.ts): each server's handle goes
   * to the runtime that issued it. The console, probe and logs route the same way.
   */
  runtime: Runtimes
  console: ServerConsole
  probe: ReadinessProbe
  profiles: PlayerProfiles
  logs: LogSource
  catalog: ModCatalog
  /** Counting what the surfaces nobody signs in to may do (§15.6). */
  limits: Limits
  /** Each server type's build list, for the build a revision pins (§4). */
  loaderBuilds: LoaderBuilds
  /** Reading what people upload: jars and world downloads. */
  formats: FileFormats
  /** Opening and writing the pack files people upload, as the hostile input they are. */
  archives: PackArchives
  /** CurseForge, as far as Blockly may use it: its links (docs/modpack-system.md). */
  curseforge: CurseForge
  capabilities: DeploymentCapabilities
  addressing: PlayAddressing
  regions: RegionCatalog
  /** Email: admin alerts. */
  mailer: Mailer
}

export interface ControlPlaneSettings {
  /** Where new servers go unless a placement rule sends them elsewhere (docs/runtimes.md). */
  defaultRuntime: string
  /** The runtime keyring: the current key derives every server's secrets; earlier ones are still accepted. */
  runtimeSecrets: SecretKeyring
  /** The control plane as game runtimes reach it (§15.2). */
  artifactsRuntimeFacingUrl: string
  /** Keep a copy of every catalog jar a revision pins; needs the archives capability. */
  mirrorCatalogArtifacts: boolean
  bootTimeouts: BootTimeouts
  /** How long a wake from the edge waits, in all, for the server to be running. */
  wakeWaitMs: number
  /** Verified emails that are platform admins by configuration. */
  adminEmails?: readonly string[]
  /** Where people reach the web app: billing sends them back to its account page. */
  webOrigin: string
  /** Whether sign-up stops at the free-account cap; true unless this is local development. */
  signupCap?: boolean
  /** The packs Blockly offers by name; the review in `curation/packs.ts` unless a test brings its own. */
  curatedPacks?: readonly CuratedPack[]
  /** Blockly's own packs; the review in `curation/own.ts` unless a test brings its own. */
  ownPacks?: readonly OwnPack[]
}

/**
 * The application, built once from its ports. The composition root builds it with real
 * adapters; the operation tests build the same thing with fakes, so what they exercise is the
 * wiring that runs.
 */
export function composeControlPlane(ports: ControlPlanePorts, settings: ControlPlaneSettings) {
  const { db, events, runtime, profiles } = ports
  const policy = new AccessPolicy(ports.capabilities, runtime.serverCeiling)
  const placement = new RuntimePlacement({
    db,
    runtimes: runtime,
    regions: ports.regions,
    defaultProvider: settings.defaultRuntime,
    archives: ports.capabilities.archives !== null,
  })
  const transitions = new ServerTransitions(events, ports.jobs)
  const specs = new RuntimeSpecs(
    settings.runtimeSecrets,
    new ArtifactLinks(settings.artifactsRuntimeFacingUrl, settings.runtimeSecrets),
  )
  // Setups resolve mods through the catalog, which needs revisions, which need servers: the
  // server service reaches for setups only when a server is being made, so it takes a getter.
  let setups: SetupService
  const servers = new MinecraftServerService({
    db,
    policy,
    transitions,
    events,
    addressing: ports.addressing,
    regions: ports.regions,
    placement,
    jobs: ports.jobs,
    loaderBuilds: ports.loaderBuilds,
    setups: () => setups,
  })

  const artifacts = new ArtifactService({
    db,
    archive: ports.capabilities.archives,
    secrets: settings.runtimeSecrets,
    mirror: settings.mirrorCatalogArtifacts,
    jobs: ports.jobs,
    locks: ports.locks,
  })
  const revisions = new RevisionService({
    db,
    policy,
    transitions,
    events,
    artifacts,
    providers: runtime.providers,
    loaderBuilds: ports.loaderBuilds,
  })
  const catalog = new CatalogSync({ db, catalog: ports.catalog })
  const listings = new ListingService({
    db,
    policy,
    events,
    jobs: ports.jobs,
    catalog: ports.catalog,
    sync: catalog,
    providers: runtime.providers,
    mailer: ports.mailer,
    webOrigin: settings.webOrigin,
  })
  const mods = new ModService({
    db,
    catalog: ports.catalog,
    sync: catalog,
    revisions,
    policy,
    capabilities: ports.capabilities,
    formats: ports.formats,
    catalogMoved: (moved) => listings.catalogMoved(moved),
    loaderBuilds: ports.loaderBuilds,
  })
  const contents = new PackContents({ db, formats: ports.formats, catalog: ports.catalog })
  const packs = new PackService({
    db,
    policy,
    capabilities: ports.capabilities,
    jobs: ports.jobs,
    builder: new PackBuilder({
      archives: ports.archives,
      formats: ports.formats,
      catalog: ports.catalog,
      curseforge: ports.curseforge,
      loaderBuilds: ports.loaderBuilds,
    }),
    archives: ports.archives,
    catalog: ports.catalog,
    curseforge: ports.curseforge,
  })
  setups = new SetupService({
    db,
    mods,
    catalog: ports.catalog,
    formats: ports.formats,
    providers: runtime.providers,
    contents,
    packs,
    curation: () => curation,
  })
  const curation: PackCuration = new PackCuration({
    db,
    catalog: ports.catalog,
    archives: ports.archives,
    formats: ports.formats,
    contents,
    capabilities: ports.capabilities,
    jobs: ports.jobs,
    pin: (projectId, versionId) => setups.pinnedPack(projectId, versionId),
    resolve: (target, wanted) => mods.resolveNew(target, wanted),
    loaderBuilds: ports.loaderBuilds,
    ...(settings.curatedPacks === undefined ? {} : { packs: settings.curatedPacks }),
    ...(settings.ownPacks === undefined ? {} : { own: settings.ownPacks }),
  })
  const queries = new ServerQueries({
    db,
    addressing: ports.addressing,
    regions: ports.regions,
    service: servers,
    setups,
    catalog: ports.catalog,
    packs,
    curation,
    providers: runtime.providers,
  })
  const access = new AccessService({ db, policy, profiles, transitions, events })
  const sharing = new SharingService({ db, access })
  const accounts = new AccountService({
    db,
    servers,
    jobs: ports.jobs,
    mailer: ports.mailer,
    webOrigin: settings.webOrigin,
    configured: { admins: settings.adminEmails ?? [], signupCap: settings.signupCap ?? true },
  })
  const billing = new BillingService({ ...ports, db, policy, accounts, webOrigin: settings.webOrigin })
  const backups = new BackupService({
    db,
    transitions,
    events,
    runtime,
    policy,
    artifacts,
    ports,
  })
  const worlds = new WorldService({ db, transitions, events, providers: runtime.providers })
  const reconciler = new AccessReconciler({ db, runtime, console: ports.console, profiles, specs, events })
  const consoleService = new ConsoleService({ db, policy, runtime, console: ports.console, specs })
  const players = new PlayerService({ ...ports, policy, specs })
  const schedules = new Schedules({
    db,
    runtime,
    placement,
    console: ports.console,
    specs,
    transitions,
    events,
    service: servers,
    backups,
    catalog,
    listings,
    players,
    storing: ports.capabilities.archives !== null,
    mailer: ports.mailer,
    webOrigin: settings.webOrigin,
  })
  const boot = new BootSequence({
    runtime,
    probe: ports.probe,
    access: reconciler,
    artifacts,
    logs: ports.logs,
    timeouts: settings.bootTimeouts,
    packs: contents,
    console: ports.console,
    rconPasswords: (serverId) => specs.rconPasswords(serverId),
  })
  const runner = new OperationRunner(
    { db, transitions, events },
    createHandlers({
      ...ports,
      placement,
      transitions,
      policy,
      specs,
      boot,
      access: reconciler,
      players,
      artifacts,
      backups,
      archives: ports.capabilities.archives,
      webOrigin: settings.webOrigin,
    }),
  )
  const alerts = new PlatformAlerts({
    db,
    jobs: ports.jobs,
    catalog,
    mailer: ports.mailer,
    webOrigin: settings.webOrigin,
  })
  const waiter = new ServerWaiter(db, events)
  const edge = new EdgeService({
    db,
    addressing: ports.addressing,
    runtime,
    service: servers,
    waiter,
    schedules,
    events,
    wakeWaitMs: settings.wakeWaitMs,
  })

  return {
    policy,
    transitions,
    specs,
    servers,
    accounts,
    accountQueries: new AccountQueries({ db, policy }),
    billing,
    listings,
    listingQueries: new ListingQueries({ db, addressing: ports.addressing }),
    sharing,
    sharingQueries: new SharingQueries({
      db,
      addressing: ports.addressing,
      catalog: ports.catalog,
      limits: ports.limits,
      webOrigin: settings.webOrigin,
      providers: runtime.providers,
    }),
    guestbook: new GuestbookService({ db, policy }),
    insight: new InsightService({ db, insight: ports.capabilities.insight ?? null }),
    revisions,
    catalog,
    mods,
    modQueries: new ModQueries({ db, policy, catalog: ports.catalog, packs, contents, curation }),
    queries,
    setups,
    packs,
    curation,
    packChanges: new PackChanges({ db, setups, packs, revisions, curation }),
    access,
    players,
    faces: new PlayerFaces({ profiles, limits: ports.limits }),
    reconciler,
    artifacts,
    backups,
    backupQueries: new BackupQueries({ db, policy }),
    worlds,
    worldQueries: new WorldQueries({ db, providers: runtime.providers }),
    console: consoleService,
    schedules,
    boot,
    runner,
    platform: new PlatformControlsService({
      db,
      catalog,
      refresh: () => schedules.catalogRefresh(),
      addressing: ports.addressing,
      serverCeiling: runtime.serverCeiling,
      runtimeKeys: () => ({
        version: settings.runtimeSecrets.current.version,
        previousVersions: settings.runtimeSecrets.previous.map((k) => k.version),
      }),
    }),
    stuck: new StuckWork({ db, jobs: ports.jobs, runner }),
    alerts,
    audit: new AuditQueries({ db }),
    fleet: new Fleet({ db, runtime }),
    placement,
    economics: new RuntimeEconomics({ db, runtimes: runtime }),
    /** Start it before the edge's wakes are served. */
    waiter,
    edge,
    feed: new ConsoleFeed(db, ports.logs, runtime.providers),
  }
}

export type ControlPlane = ReturnType<typeof composeControlPlane>
