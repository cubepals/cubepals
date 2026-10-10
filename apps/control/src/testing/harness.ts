// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, createPool, type Db, migrationsFolder, schema } from '@blockly/db'
import { getRequestListener } from '@hono/node-server'
import { asc, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import type { PgBoss } from 'pg-boss'
import type { UserActor } from '../app/actor.ts'
import type { DeploymentCapabilities } from '../app/capabilities.ts'
import { type ControlPlane, composeControlPlane } from '../app/control-plane.ts'
import type { OwnPack } from '../app/curation/own.ts'
import type { CuratedPack } from '../app/curation/packs.ts'
import { type OperationRecord, toRecord } from '../app/operations/persistence.ts'
import type { EventBus } from '../app/ports/events.ts'
import type { JobQueue } from '../app/ports/jobs.ts'
import type { ReadinessProbe, ServerConsole } from '../app/ports/minecraft.ts'
import type { LogSource } from '../app/ports/platform.ts'
import type { MinecraftRuntime, RuntimeCapacity, RuntimePrices } from '../app/ports/runtime.ts'
import { RoutedAdapters, RuntimeRouter } from '../app/runtimes/router.ts'
import { type SecretKeyring, singleKey } from '../app/secrets.ts'
import { findServer } from '../app/servers/persistence.ts'
import type { CreateServerRequest } from '../app/servers/service.ts'
import { ConfiguredPlayAddressing, ConfiguredRegionCatalog } from '../config/play-addressing.ts'
import type { MinecraftServer } from '../domain/server/server.ts'
import { CurseForgeLinks } from '../infra/curseforge/curseforge-links.ts'
import { FakeCatalog } from '../infra/fake/fake-catalog.ts'
import { FakeLoaderBuilds } from '../infra/fake/fake-loader-builds.ts'
import { FakeMinecraft } from '../infra/fake/fake-minecraft.ts'
import { FakeProfiles } from '../infra/fake/fake-profiles.ts'
import { FakeRuntime, fakeHandleKey } from '../infra/fake/fake-runtime.ts'
import { LibraryFileFormats } from '../infra/formats/file-formats.ts'
import { LibraryPackArchives } from '../infra/formats/pack-archives.ts'
import { MemoryLimits } from '../infra/limits/memory-limits.ts'
import { PgNotifyEventBus } from '../infra/pg/events.ts'
import {
  PgBossJobs,
  startBoss,
  workArtifactMirror,
  workListingEligibility,
  workPackImports,
  workServerOperations,
  workWorldDownloads,
} from '../infra/pg/jobs.ts'
import { PgAdvisoryLocks } from '../infra/pg/locks.ts'
import { createRuntimeApp } from '../interfaces/runtime/artifacts.ts'
import { Outbox } from './outbox.ts'

/**
 * The control plane in one process, for operation tests. Real Postgres (a database of its own,
 * dropped at the end), real pg-boss and the real event bus; the fake provider, fake Minecraft
 * servers and fake player profiles in place of Docker, Fly and Mojang. The application itself is
 * `composeControlPlane`, exactly as main.node.ts builds it.
 */
export interface Harness {
  app: ControlPlane
  db: Db
  /** The job queue the application uses, for tests that build a service of their own. */
  jobs: JobQueue
  /** The event bus the application publishes on, for tests that listen to what it announces. */
  events: EventBus
  /** The default runtime: where every new server goes unless a placement rule says otherwise. */
  runtime: FakeRuntime
  /** Every runtime the deployment runs, the default (`fake`) and any `otherRuntimes`, by provider. */
  runtimes: ReadonlyMap<string, FakeRuntime>
  minecraft: FakeMinecraft
  profiles: FakeProfiles
  catalog: FakeCatalog
  /** Every email the application sent. */
  mail: Outbox
  /** Each server type's current build, as the test sets it. */
  loaderBuilds: FakeLoaderBuilds
  /** Where game runtimes fetch their jars: the runtime endpoint, served on a local port. */
  artifactsUrl: string
  /** A person with a confirmed email, on `plan` (free by default, as a new account is). */
  user(name?: string, plan?: string): Promise<UserActor>
  create(actor: UserActor, request?: Partial<CreateServerRequest>): Promise<MinecraftServer>
  /** Waits for the server to reach a status, or for any condition on it. */
  until(
    serverId: string,
    want: MinecraftServer['lifecycle']['status'] | ((server: MinecraftServer) => boolean),
    timeoutMs?: number,
  ): Promise<MinecraftServer>
  /** Waits until nothing is queued or running for the server. */
  settled(serverId: string, timeoutMs?: number): Promise<OperationRecord[]>
  operations(serverId: string): Promise<OperationRecord[]>
  server(serverId: string): Promise<MinecraftServer>
  close(): Promise<void>
}

export interface HarnessOptions {
  /** Or made from the harness's database, for an adapter that keeps its record there. */
  capabilities?: DeploymentCapabilities | ((db: Db) => DeploymentCapabilities)
  mirrorCatalogArtifacts?: boolean
  adminEmails?: readonly string[]
  /** How long an operation's attempt may run before the queue gives up on it (default 30 min). */
  operationDeadlineSeconds?: number
  /** The most servers the provider holds, by its own limit; none by default. */
  serverCeiling?: number
  /** The runtime keyring; one key, version 1, by default. */
  runtimeSecrets?: SecretKeyring
  /** What the provider charges; nothing by default. */
  runtimePrices?: RuntimePrices
  /** Compute comes back at another edge address each time it starts, as on Boat. */
  movingAddresses?: boolean
  /**
   * A real provider in place of the fake, for a live run against it (scripts/boat-live.ts), with
   * the timeouts a real boot needs.
   */
  provider?: {
    runtime: MinecraftRuntime
    console: ServerConsole
    probe: ReadinessProbe
    logs: LogSource
    bootTimeouts: { runningMs: number; readyMs: number }
    wakeWaitMs: number
  }
  /**
   * More fake runtimes beside the default one, by provider id, as a deployment running several
   * (docs/runtimes.md), each with its prices and the machines it pays for.
   */
  otherRuntimes?: ReadonlyArray<{ provider: string; prices?: RuntimePrices; capacity?: RuntimeCapacity }>
  /**
   * The packs Blockly offers by name. Their releases are checked only when a test calls
   * `curation.ingest`: no worker runs them, so nothing checks one behind a test's back.
   */
  curatedPacks?: readonly CuratedPack[]
  /** Blockly's own packs, checked the same way: only when a test asks. */
  ownPacks?: readonly OwnPack[]
  /**
   * Platform controls set over the migrations' defaults (docs/money-guards.md). By default
   * the roomier caps the operation tests were written against, since a file keeps more than ten
   * servers running; `{}` keeps the defaults, for tests of the caps themselves.
   */
  controls?: Partial<typeof schema.platformControls.$inferInsert>
}

/** The caps the operation tests run under unless they ask otherwise. */
const TEST_CONTROLS = { maxServers: 40, maxRunningServers: 15 }

/**
 * For @hono/node-server's listener: left to its default, it puts its own Response in the global's
 * place for the rest of the process, and every later test file's Bun.serve then answers with one
 * it can't send.
 */
const KEEP = { overrideGlobalObjects: false }

/** A new database migrated, with `controls` set over the platform controls the migrations left. */
async function migrated(db: Db, controls: HarnessOptions['controls'] = TEST_CONTROLS): Promise<void> {
  await migrate(db, { migrationsFolder })
  if (Object.keys(controls).length > 0) await db.update(schema.platformControls).set(controls)
}

/** The capabilities a test asked for, made from the harness's database if it asked that way. */
const capabilitiesOf = ({ capabilities }: HarnessOptions, db: Db): DeploymentCapabilities =>
  typeof capabilities === 'function' ? capabilities(db) : (capabilities ?? { archives: null, billing: null })

/** Operation tests need Postgres; like the lock tests, they run where DATABASE_URL is set. */
export const hasDatabase = Boolean(process.env.DATABASE_URL)

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const base = process.env.DATABASE_URL
  if (!base) throw new Error('DATABASE_URL is not set')
  const name = `blockly_test_${randomBytes(5).toString('hex')}`
  const admin = new pg.Client({ connectionString: base })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = new URL(base)
  url.pathname = `/${name}`

  const pool = createPool(url.toString())
  const db = createDb(pool)
  await migrated(db, options.controls)
  const events = new PgNotifyEventBus(url.toString())
  const boss: PgBoss = await startBoss(url.toString(), {
    retryDelaySeconds: 0,
    ...(options.operationDeadlineSeconds
      ? { operationDeadlineSeconds: options.operationDeadlineSeconds }
      : {}),
  })
  const jobs = new PgBossJobs(boss)
  const root = await mkdtemp(join(tmpdir(), 'blockly-fake-'))

  const mail = new Outbox()
  const profiles = new FakeProfiles()
  const catalog = new FakeCatalog()
  const loaderBuilds = new FakeLoaderBuilds()
  const minecraft = new FakeMinecraft(profiles, fakeHandleKey)
  const runtime = new FakeRuntime({
    deploymentId: 'test',
    root,
    regionMap: { local: 'fake-1', far: 'fake-2' },
    workload: minecraft,
    serverCeiling: options.serverCeiling ?? null,
    prices: options.runtimePrices ?? null,
    movingAddresses: options.movingAddresses ?? false,
  })
  const runtimes = new Map<string, FakeRuntime>([[runtime.provider, runtime]])
  for (const other of options.otherRuntimes ?? [])
    runtimes.set(
      other.provider,
      new FakeRuntime({
        provider: other.provider,
        deploymentId: 'test',
        root,
        regionMap: { local: 'fake-1', far: 'fake-2' },
        workload: minecraft,
        prices: other.prices ?? null,
        capacity: other.capacity ?? null,
      }),
    )
  // A real provider, for a live run, stands alone; otherwise every fake, the default first.
  const members: MinecraftRuntime[] =
    options.provider === undefined ? [...runtimes.values()] : [options.provider.runtime]
  const router = new RuntimeRouter(members)
  const adapters = options.provider ?? { console: minecraft, probe: minecraft, logs: minecraft }
  const routed = new RoutedAdapters(
    router,
    new Map(members.map((member) => [member.provider, adapters] as const)),
  )
  const regions = [
    { key: 'local', label: 'This computer' },
    { key: 'far', label: 'Far away' },
  ]
  // Links are built from this address, so it listens before the application it serves exists.
  let runtimeFacing: ReturnType<typeof createRuntimeApp> | null = null
  const answer = (request: Request) => runtimeFacing?.fetch(request) ?? new Response(null, { status: 503 })
  const artifactsServer = createServer(getRequestListener(answer, KEEP))
  await new Promise<void>((resolve) => artifactsServer.listen(0, '127.0.0.1', resolve))
  const artifactsUrl = `http://127.0.0.1:${(artifactsServer.address() as AddressInfo).port}`
  const app = composeControlPlane(
    {
      db,
      events,
      jobs,
      locks: new PgAdvisoryLocks(pool),
      limits: new MemoryLimits(),
      runtime: router,
      console: routed.console,
      probe: routed.probe,
      profiles,
      logs: routed.logs,
      catalog,
      loaderBuilds,
      formats: new LibraryFileFormats(),
      archives: new LibraryPackArchives(),
      curseforge: new CurseForgeLinks(),
      capabilities: capabilitiesOf(options, db),
      addressing: new ConfiguredPlayAddressing({
        domain: 'play.test',
        aliases: ['play.old.test'],
        port: 25565,
      }),
      regions: new ConfiguredRegionCatalog(regions),
      mailer: mail,
    },
    {
      defaultRuntime: members[0]?.provider ?? runtime.provider,
      runtimeSecrets: options.runtimeSecrets ?? singleKey('test-runtime-secrets-key-0123456789'),
      artifactsRuntimeFacingUrl: artifactsUrl,
      mirrorCatalogArtifacts: options.mirrorCatalogArtifacts ?? false,
      adminEmails: options.adminEmails ?? [],
      webOrigin: 'http://localhost:3000',
      curatedPacks: options.curatedPacks ?? [],
      ownPacks: options.ownPacks ?? [],
      bootTimeouts: options.provider?.bootTimeouts ?? { runningMs: 5_000, readyMs: 3_000 },
      wakeWaitMs: options.provider?.wakeWaitMs ?? 5_000,
    },
  )
  runtimeFacing = createRuntimeApp({ artifacts: app.artifacts })
  await app.waiter.start()
  await workQueues(boss, app)

  const server = async (serverId: string) => {
    const found = await findServer(db, serverId)
    if (found === null) throw new Error(`No server ${serverId}`)
    return found
  }
  const operations = async (serverId: string) => {
    const rows = await db
      .select()
      .from(schema.serverOperations)
      .where(eq(schema.serverOperations.serverId, serverId))
      .orderBy(asc(schema.serverOperations.createdAt))
    return rows.map(toRecord)
  }

  return {
    app,
    db,
    jobs,
    events,
    runtime,
    runtimes,
    minecraft,
    profiles,
    catalog,
    mail,
    loaderBuilds,
    artifactsUrl,

    async user(name = 'Steve', plan = 'free') {
      const id = randomUUID()
      await db.insert(schema.users).values({ id, name, email: `${id}@example.test`, emailVerified: true })
      await db.insert(schema.accountStanding).values({ userId: id, plan }).onConflictDoNothing()
      return { kind: 'user', userId: id }
    },

    create(actor, request = {}) {
      return app.servers.createMinecraftServer(actor, {
        idempotencyKey: randomUUID(),
        name: 'Test server',
        playStyle: 'survival',
        partySize: '5',
        regionKey: 'local',
        ...request,
      })
    },

    async until(serverId, want, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      const matches =
        typeof want === 'function' ? want : (found: MinecraftServer) => found.lifecycle.status === want
      let last: MinecraftServer | null = null
      while (Date.now() < deadline) {
        last = await server(serverId)
        if (matches(last)) return last
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error(
        `Timed out waiting for ${typeof want === 'string' ? want : 'a condition'}; the server is ${last?.lifecycle.status}${
          last?.lifecycle.status === 'failed' ? ` (${JSON.stringify(last.lifecycle.failure)})` : ''
        }`,
      )
    },

    async settled(serverId, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const all = await operations(serverId)
        if (all.every((op) => op.status !== 'queued' && op.status !== 'running')) return all
        if (Date.now() > deadline)
          throw new Error(
            `Operations still pending: ${all.map((op) => `${op.kind}:${op.status}`).join(', ')}`,
          )
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },

    operations,
    server,

    async close() {
      await new Promise((resolve) => artifactsServer.close(resolve))
      await app.waiter.stop()
      await boss.stop({ graceful: false })
      await events.close()
      await pool.end()
      await rm(root, { recursive: true, force: true })
      const cleanup = new pg.Client({ connectionString: base })
      await cleanup.connect()
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await cleanup.end()
    },
  }
}

/** Every queue the application's work goes through, worked here, polled often. */
async function workQueues(boss: PgBoss, app: ControlPlane): Promise<void> {
  await workServerOperations(boss, (attempt) => app.runner.run(attempt), 4, 0.5)
  await workArtifactMirror(boss, (artifact) => app.artifacts.mirror(artifact), 0.5)
  await workPackImports(
    boss,
    { run: (id) => app.packs.runImport(id), gaveUp: (id, error) => app.packs.importGaveUp(id, error) },
    0.5,
  )
  await workWorldDownloads(boss, app.backups.downloads, 0.5)
  await workListingEligibility(boss, (serverIds) => app.listings.reevaluate(serverIds), 0.5)
}
