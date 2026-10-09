import type { Tx } from '@blockly/db'
import { sql } from 'drizzle-orm'
import { fromDrizzle, PgBoss } from 'pg-boss'
import type {
  BlockedOperation,
  CurationJob,
  JobAttempt,
  JobQueue,
  MirrorJob,
  ScheduledJob,
} from '../../app/ports/jobs.ts'

/** One queue for every server operation: strict FIFO per server, parallel across servers. */
const SERVER_OPS = 'server-ops'
/** Catalog jars to copy into the store: one job per sha512 queued or running at a time. */
const ARTIFACT_MIRROR = 'artifact-mirror'
/** Sets of servers whose listings to re-evaluate. */
const LISTING_ELIGIBILITY = 'listing-eligibility'
/** Uploaded packs to read and build: one job per upload. */
const PACK_IMPORT = 'pack-import'
/** World downloads to copy out of their archives: one job per copy. */
const WORLD_DOWNLOAD = 'world-download'
/** Reviewed releases of curated packs to fetch and check: one job per release at a time. */
const CURATION_INGEST = 'curation-ingest'

/**
 * Tests shorten the wait between an operation's attempts, and some the deadline of each; everything
 * else keeps the defaults. Only a process that works the queues keeps them (`maintains`): expiring,
 * archiving and sending what the schedules owe. A process that only sends jobs leaves that to it,
 * rather than every process repeating the same upkeep against the one database.
 */
export async function startBoss(
  connectionString: string,
  options: { retryDelaySeconds?: number; operationDeadlineSeconds?: number; maintains?: boolean } = {},
): Promise<PgBoss> {
  const maintains = options.maintains ?? true
  const boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    application_name: 'blockly-jobs',
    supervise: maintains,
    schedule: maintains,
  })
  boss.on('error', (error: unknown) => console.error('pg-boss', error))
  await boss.start()
  await boss.createQueue(SERVER_OPS, {
    policy: 'key_strict_fifo',
    ...((options.retryDelaySeconds ?? 5) > 0
      ? { retryDelay: options.retryDelaySeconds ?? 5, retryBackoff: true, retryDelayMax: 120 }
      : { retryDelay: 0, retryBackoff: false }),
    // First boots generate a world; give an operation half an hour before it counts as stuck.
    expireInSeconds: options.operationDeadlineSeconds ?? 1800,
  })
  await boss.createQueue(LISTING_ELIGIBILITY, {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 10,
    expireInSeconds: 300,
  })
  // Reading a pack downloads and rewrites up to a few gigabytes: one try more, then its owner is told.
  await boss.createQueue(PACK_IMPORT, {
    policy: 'standard',
    retryLimit: 1,
    retryDelay: 30,
    expireInSeconds: 1800,
  })
  // A copy reads and writes a world of up to a few gigabytes, as a pack import does.
  await boss.createQueue(WORLD_DOWNLOAD, {
    policy: 'standard',
    retryLimit: 1,
    retryDelay: 30,
    expireInSeconds: 1800,
  })
  // Checking a release fetches every file it installs, a few hundred megabytes for a big pack, so
  // it gets as long as an upload; a check that fails twice is refused, for an admin to look at.
  await boss.createQueue(CURATION_INGEST, {
    policy: 'exclusive',
    retryLimit: 1,
    retryDelay: 60,
    expireInSeconds: 1800,
  })
  await boss.createQueue(ARTIFACT_MIRROR, {
    policy: 'exclusive',
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 900,
  })
  return boss
}

export class PgBossJobs implements JobQueue {
  readonly #boss: PgBoss

  constructor(boss: PgBoss) {
    this.#boss = boss
  }

  async enqueue(tx: Tx, job: { operationId: string; serverId: string; retryLimit: number }): Promise<void> {
    await this.#boss.send(
      SERVER_OPS,
      { operationId: job.operationId },
      {
        id: job.operationId,
        singletonKey: job.serverId,
        retryLimit: job.retryLimit,
        db: fromDrizzle(tx, sql),
      },
    )
  }

  async enqueueEligibility(serverIds: readonly string[], tx?: Tx): Promise<void> {
    if (serverIds.length === 0) return
    await this.#boss.send(
      LISTING_ELIGIBILITY,
      { serverIds: [...new Set(serverIds)] },
      tx === undefined ? {} : { db: fromDrizzle(tx, sql) },
    )
  }

  async enqueueMirror(tx: Tx, artifact: MirrorJob): Promise<void> {
    await this.#boss.send(ARTIFACT_MIRROR, artifact, {
      singletonKey: artifact.sha512,
      db: fromDrizzle(tx, sql),
    })
  }

  async enqueuePackImport(tx: Tx, importId: string): Promise<void> {
    await this.#boss.send(PACK_IMPORT, { importId }, { id: importId, db: fromDrizzle(tx, sql) })
  }

  async enqueueWorldDownload(tx: Tx, downloadId: string): Promise<void> {
    await this.#boss.send(WORLD_DOWNLOAD, { downloadId }, { id: downloadId, db: fromDrizzle(tx, sql) })
  }

  async enqueueCuration(release: CurationJob, tx?: Tx): Promise<void> {
    await this.#boss.send(
      CURATION_INGEST,
      { key: release.key, version: release.version },
      { singletonKey: `${release.key}@${release.version}`, ...(tx ? { db: fromDrizzle(tx, sql) } : {}) },
    )
  }

  /** `key_strict_fifo` keeps a key's failed job at its head: that key is blocked. */
  async blockedOperations(): Promise<BlockedOperation[]> {
    const blocked: BlockedOperation[] = []
    for (const serverId of await this.#boss.getBlockedKeys(SERVER_OPS)) {
      for (const job of await this.#boss.findJobs(SERVER_OPS, { key: serverId })) {
        if (job.state !== 'failed') continue
        const output = job.output as { message?: unknown } | null
        blocked.push({
          operationId: job.id,
          serverId,
          failedAt: job.completedOn,
          error: typeof output?.message === 'string' ? output.message : null,
        })
      }
    }
    return blocked
  }

  async retryBlocked(operationId: string): Promise<void> {
    await this.#boss.retry(SERVER_OPS, operationId)
  }

  async discardBlocked(operationId: string): Promise<void> {
    await this.#boss.deleteJob(SERVER_OPS, operationId)
  }
}

/** Re-evaluates listings as their inputs change (§15.3). */
export async function workListingEligibility(
  boss: PgBoss,
  reevaluate: (serverIds: string[]) => Promise<void>,
  pollingIntervalSeconds = 1,
): Promise<void> {
  await boss.work(LISTING_ELIGIBILITY, { batchSize: 1, pollingIntervalSeconds }, async ([job]) => {
    if (job) await reevaluate((job.data as { serverIds: string[] }).serverIds)
  })
}

/**
 * Reads and builds uploaded packs, one at a time on each worker. The last attempt that fails
 * tells the pack's owner it couldn't be read, rather than leaving it reading forever.
 */
export async function workPackImports(
  boss: PgBoss,
  handlers: {
    run: (importId: string) => Promise<void>
    gaveUp: (importId: string, error: string) => Promise<void>
  },
  pollingIntervalSeconds = 2,
): Promise<void> {
  await boss.work(
    PACK_IMPORT,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds, includeMetadata: true },
    async ([job]) => {
      if (!job) return
      const { importId } = job.data as { importId: string }
      try {
        await handlers.run(importId)
      } catch (error) {
        if (job.retryCount >= job.retryLimit)
          await handlers.gaveUp(importId, error instanceof Error ? error.message : String(error))
        throw error
      }
    },
  )
}

/**
 * Makes world downloads, one at a time on each worker. The last attempt that fails tells the
 * archive's owner the download couldn't be made, rather than leaving it being made forever.
 */
export async function workWorldDownloads(
  boss: PgBoss,
  downloads: {
    make: (downloadId: string) => Promise<void>
    gaveUp: (downloadId: string, error: string) => Promise<void>
  },
  pollingIntervalSeconds = 2,
): Promise<void> {
  await boss.work(
    WORLD_DOWNLOAD,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds, includeMetadata: true },
    async ([job]) => {
      if (!job) return
      const { downloadId } = job.data as { downloadId: string }
      try {
        await downloads.make(downloadId)
      } catch (error) {
        if (job.retryCount >= job.retryLimit)
          await downloads.gaveUp(downloadId, error instanceof Error ? error.message : String(error))
        throw error
      }
    },
  )
}

/**
 * Checks reviewed releases of curated packs, one at a time on each worker. The last attempt that
 * fails refuses the release with what went wrong, rather than leaving it pending forever.
 */
export async function workCuration(
  boss: PgBoss,
  handlers: {
    run: (release: CurationJob) => Promise<void>
    gaveUp: (release: CurationJob, error: string) => Promise<void>
  },
  pollingIntervalSeconds = 2,
): Promise<void> {
  await boss.work(
    CURATION_INGEST,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds, includeMetadata: true },
    async ([job]) => {
      if (!job) return
      const release = job.data as CurationJob
      try {
        await handlers.run(release)
      } catch (error) {
        if (job.retryCount >= job.retryLimit)
          await handlers.gaveUp(release, error instanceof Error ? error.message : String(error))
        throw error
      }
    },
  )
}

/** Copies catalog jars into the store as revisions pin them; a failed copy is retried. */
export async function workArtifactMirror(
  boss: PgBoss,
  mirror: (artifact: MirrorJob) => Promise<void>,
  pollingIntervalSeconds = 2,
): Promise<void> {
  await boss.work(
    ARTIFACT_MIRROR,
    { batchSize: 1, localConcurrency: 2, pollingIntervalSeconds },
    async ([job]) => {
      if (job) await mirror(job.data as MirrorJob)
    },
  )
}

export async function workServerOperations(
  boss: PgBoss,
  run: (attempt: JobAttempt) => Promise<void>,
  concurrency: number,
  pollingIntervalSeconds = 1,
): Promise<void> {
  await boss.work(
    SERVER_OPS,
    { batchSize: 1, includeMetadata: true, localConcurrency: concurrency, pollingIntervalSeconds },
    async ([job]) => {
      if (!job) return
      const { operationId } = job.data as { operationId: string }
      // pg-boss keeps the error as JSON, which can't hold a NUL: a message quoting raw bytes from
      // a provider's stream would leave the job unrecorded until it expired.
      await run({ operationId, retryCount: job.retryCount, retryLimit: job.retryLimit }).catch(
        (error: unknown) => {
          if (!(error instanceof Error) || !error.message.includes('\u0000')) throw error
          throw new Error(error.message.replaceAll('\u0000', ''))
        },
      )
    },
  )
}

const CRON: Record<ScheduledJob, string> = {
  reconcile: '* * * * *',
  drift: '* * * * *',
  relocations: '* * * * *',
  'presence-sync': '* * * * *',
  'idle-check': '* * * * *',
  'session-check': '* * * * *',
  'disk-check': '*/10 * * * *',
  'purge-sweep': '*/10 * * * *',
  // A server made for a while goes within a few minutes of its time, not on the hour.
  'expiry-sweep': '*/5 * * * *',
  // Worlds rest after days without play: once an hour finds them soon enough.
  'store-sweep': '47 * * * *',
  // Worlds kept a year after their last play: once a day, early, when the emails go.
  'retention-sweep': '13 6 * * *',
  orphans: '17 * * * *',
  'catalog-refresh': '41 * * * *',
  // The default modpack list's packs, checked before anybody picks one (§15.6).
  'pack-checks': '29 * * * *',
  // Reviewed releases of curated packs a deploy brought, queued to be checked.
  curation: '53 * * * *',
  'backup-schedule': '23 * * * *',
  'artifact-gc': '37 4 * * *',
  'standing-sweep': '* * * * *',
  'listing-eligibility-sweep': '51 3 * * *',
  'admin-alerts': '*/5 * * * *',
  // A day's spend against its limit (docs/money-guards.md). At the most the platform runs at
  // once, ten minutes between passes is about 35 cents past the limit before it pauses.
  'spend-watchdog': '*/10 * * * *',
  'usage-close': '*/10 * * * *',
  // Whose each server is and what it's called, at the provider: a rename shows there within minutes.
  'provider-tags': '*/10 * * * *',
  // What a runtime keeps tidy behind its port (the fleet's uploads, copies and health records).
  'runtime-upkeep': '* * * * *',
  // Funnel events kept as they happened, sent to PostHog within a minute.
  'insight-send': '* * * * *',
}

/**
 * Periodic work. Each runs as a singleton, so two workers never sweep at once. The most frequent
 * fires once a minute, so looking for it every ten seconds is soon enough, and spares the database
 * a query every two seconds for each of them.
 */
export async function workSchedules(
  boss: PgBoss,
  jobs: Record<ScheduledJob, () => Promise<void>>,
): Promise<void> {
  for (const [name, cron] of Object.entries(CRON) as Array<[ScheduledJob, string]>) {
    await boss.createQueue(name, { policy: 'singleton', retryLimit: 0, expireInSeconds: 300 })
    await boss.schedule(name, cron)
    await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 10 }, async () => {
      await jobs[name]()
    })
  }
}
