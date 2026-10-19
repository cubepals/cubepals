// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { DAY_S, HOUR_S, MINUTE_MS, MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import { POOL_IDLE_MS, type Tx } from '@blockly/db'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { fromDrizzle, type Job, PgBoss, type QueueOptions } from 'pg-boss'
import { notifyQueue } from 'pg-boss/dist/plans.js'
import type {
  BlockedOperation,
  CurationJob,
  JobAttempt,
  JobOutcomes,
  JobQueue,
  MirrorJob,
  Schedule,
  ScheduledJob,
  WorkerHeartbeat,
} from '../../app/ports/jobs.ts'
import { catchUp } from './catch-up.ts'
import { Lanes } from './lanes.ts'
import { everyMinute } from './ticker.ts'

/** The Postgres schema pg-boss keeps its tables in. */
const SCHEMA = 'pgboss'
/** One queue for every server operation: strict FIFO per server, parallel across servers. */
const SERVER_OPS = 'server-ops'
/**
 * The priority a start or a wake goes in at: fetched before everything else, and the least the
 * wake lane takes. Everything else keeps pg-boss's default, 0, but a new server's first build. Priority orders the heads of the
 * servers' queues; it never lets an operation pass one queued before it for the same server.
 */
const WAKE_PRIORITY = 1
/** A start or a wake on a paid plan: ahead of other wakes, in either lane. */
const PAID_WAKE_PRIORITY = 2
/** A new server's first build: behind everything for the servers people already have. */
const CREATE_PRIORITY = -1
/**
 * How often, in seconds, a worker's word that it still holds an operation may go unsaid before
 * the operation counts as cut off: pg-boss's floor. A worker says so every half of it.
 */
export const OPERATION_HEARTBEAT_SECONDS = 10
/**
 * What the queue records on an attempt whose worker went away: a heartbeat that lapsed (ours, or
 * pg-boss's own check), or a stop that outlasted its drain.
 */
const CUT_OFF = new Set([
  'cut off: its worker stopped',
  'job heartbeat timeout',
  'pg-boss shut down while active',
])
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
/** Uploaded jars to read for malware: one job per bytes queued or running at a time. */
const JAR_CHECK = 'jar-check'
/**
 * The tries after the first that a pack import, a world copy and a release check get: each moves
 * gigabytes, so one, then its owner is told. Their jobs keep their queue's.
 */
const HEAVY_RETRIES = 1

/**
 * How often a worker asks for work while the database tells it of each job sent (LISTEN/NOTIFY):
 * only to catch what it wasn't told of, such as a retry coming due. What decides how soon user
 * actions run is the telling, not this. Where LISTEN can't be held, each worker asks at its
 * own `pollingIntervalSeconds`, as before.
 */
const BACKSTOP_SECONDS = 30
/**
 * The same, for queues that run in the background: imports, copies, checks, listings. A job they
 * retry comes due after 30 to 60 seconds and is asked for again at the next of these.
 */
const BACKGROUND_BACKSTOP_SECONDS = 5 * MINUTE_S
/**
 * pg-boss's own upkeep, at the pace its users need rather than its defaults (pg-boss 12.36,
 * `ConstructorOptions` in its types and https://pgboss.io/api/constructor). Most of its passes read
 * every queue's definition and counts, about 10 kB; the defaults ran them every minute in every
 * process, and the flow resolver's every 5 s.
 *
 * - `queueCacheIntervalSeconds`: a queue's definition changes only as a deploy starts a process,
 *   which reads them all then, so an hour.
 * - `superviseIntervalSeconds` and `monitorIntervalSeconds`: expiring jobs past their deadline and
 *   failing those whose heartbeat lapsed. A worker gives up on a job at its deadline itself, and
 *   one that restarts takes back its own at once (`takeBack`), so five minutes is soon enough for
 *   one that never comes back.
 * - `maintenanceIntervalSeconds`: deleting finished jobs past their queue's `deleteAfterSeconds`,
 *   hourly rather than daily, so the scheduled jobs' hour is kept to about that.
 * - `flowIntervalSeconds`: resolving jobs that wait on others (flows), whose every pass reads every
 *   queue's definition; it ran every 5 s. No job here waits on another, so an hour.
 * - `bamIntervalSeconds`: running the background commands a pg-boss upgrade leaves (building an
 *   index); none otherwise, and a deploy that brings one waits ten minutes for it at the most.
 * - `notifyHeartbeatIntervalMs`: checking the listening connection is alive, every minute rather
 *   than 10 s: one that dies unnoticed costs only the backstop's wait.
 * - `registerInstance`: nothing here reads pg-boss's registry of instances.
 */
const UPKEEP = {
  queueCacheIntervalSeconds: HOUR_S,
  superviseIntervalSeconds: 5 * MINUTE_S,
  monitorIntervalSeconds: 5 * MINUTE_S,
  maintenanceIntervalSeconds: HOUR_S,
  flowIntervalSeconds: HOUR_S,
  bamIntervalSeconds: 10 * MINUTE_S,
  notifyHeartbeatIntervalMs: MINUTE_MS,
  registerInstance: false,
} as const

/** How long after a retry comes due its workers are woken: past a moment's difference in clocks. */
const RETRY_DUE_MARGIN_MS = SECOND_MS / 4

/**
 * pg-boss hands its options to the pool it opens (`new pg.Pool(this.config)` in its db.js), which
 * its types don't say: its connections are kept as the query pool's are (`POOL_IDLE_MS`).
 */
const KEPT_CONNECTIONS = { idleTimeoutMillis: POOL_IDLE_MS }

/**
 * How long the other queues keep a job that has run: a day, for looking into one. Server
 * operations keep the default: a failed one holds its server's queue until an admin moves it.
 */
const BACKGROUND_KEPT = { deleteAfterSeconds: DAY_S }

/**
 * A queue as it is asked for, made when missing and, where it was made before, given what was
 * added since: each job sent tells the workers waiting on it (`notify`), and whatever `kept` names.
 */
async function ensureQueue(
  boss: PgBoss,
  name: string,
  options: QueueOptions & { policy: string },
  kept: Partial<QueueOptions> = {},
): Promise<void> {
  await boss.createQueue(name, { ...options, ...kept, notify: true })
  // createQueue leaves a queue that exists as it is.
  await boss.updateQueue(name, { ...kept, notify: true })
}

/**
 * Tests shorten the wait between an operation's attempts, and some the deadline of each; everything
 * else keeps the defaults. Only a process that works the queues keeps them (`maintains`): expiring,
 * deleting, and listening for jobs sent. A process that only sends jobs leaves that to it,
 * rather than every process repeating the same upkeep against the one database.
 */
export async function startBoss(
  connectionString: string,
  options: {
    retryDelaySeconds?: number
    operationDeadlineSeconds?: number
    maintains?: boolean
    /** Connections its own pool may hold, as createPool's `max`. */
    poolMax?: number
  } = {},
): Promise<PgBoss> {
  const maintains = options.maintains ?? true
  const boss = new PgBoss({
    connectionString,
    max: options.poolMax ?? 10,
    ...KEPT_CONNECTIONS,
    schema: SCHEMA,
    application_name: 'blockly-jobs',
    supervise: maintains,
    // Scheduled jobs are sent as their minutes come, by the workers (ticker.ts).
    schedule: false,
    // Where queues are worked, one connection of its own listens, and wakes this process's workers
    // as each job is sent. A process that only sends jobs still tells: the NOTIFY rides the send.
    useListenNotify: maintains,
    ...UPKEEP,
  })
  boss.on('error', (error: unknown) => console.error('pg-boss', error))
  // A listener that can't be opened is only a warning to pg-boss, whose workers then ask at their
  // `pollingIntervalSeconds` until the process restarts: said here, or nothing would say it.
  boss.on('warning', (warning: { message?: string }) => console.warn('pg-boss', warning.message ?? warning))
  await boss.start()
  await ensureQueue(
    boss,
    SERVER_OPS,
    {
      policy: 'key_strict_fifo',
      ...((options.retryDelaySeconds ?? 5) > 0
        ? { retryDelay: options.retryDelaySeconds ?? 5, retryBackoff: true, retryDelayMax: 120 }
        : { retryDelay: 0, retryBackoff: false }),
      // First boots generate a world; give an operation half an hour before it counts as stuck.
      expireInSeconds: options.operationDeadlineSeconds ?? 1800,
    },
    // One made before heartbeats gains them here.
    { heartbeatSeconds: OPERATION_HEARTBEAT_SECONDS },
  )
  await ensureQueue(
    boss,
    LISTING_ELIGIBILITY,
    {
      policy: 'standard',
      retryLimit: 3,
      retryDelay: 10,
      expireInSeconds: 300,
    },
    BACKGROUND_KEPT,
  )
  // Reading a pack downloads and rewrites up to a few gigabytes: one try more, then its owner is told.
  await ensureQueue(
    boss,
    PACK_IMPORT,
    {
      policy: 'standard',
      retryLimit: HEAVY_RETRIES,
      retryDelay: 30,
      expireInSeconds: 1800,
    },
    BACKGROUND_KEPT,
  )
  // A copy reads and writes a world of up to a few gigabytes, as a pack import does.
  await ensureQueue(
    boss,
    WORLD_DOWNLOAD,
    {
      policy: 'standard',
      retryLimit: HEAVY_RETRIES,
      retryDelay: 30,
      expireInSeconds: 1800,
    },
    BACKGROUND_KEPT,
  )
  // Checking a release fetches every file it installs, a few hundred megabytes for a big pack, so
  // it gets as long as an upload; a check that fails twice is refused, for an admin to look at.
  await ensureQueue(
    boss,
    CURATION_INGEST,
    {
      policy: 'exclusive',
      retryLimit: HEAVY_RETRIES,
      retryDelay: 60,
      expireInSeconds: 1800,
    },
    BACKGROUND_KEPT,
  )
  // Reading a jar takes seconds; one that can't be read stays unchecked, for an operator to see.
  await ensureQueue(
    boss,
    JAR_CHECK,
    {
      policy: 'exclusive',
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 600,
    },
    BACKGROUND_KEPT,
  )
  await ensureQueue(
    boss,
    ARTIFACT_MIRROR,
    {
      policy: 'exclusive',
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 900,
    },
    BACKGROUND_KEPT,
  )
  return boss
}

export class PgBossJobs implements JobQueue {
  readonly #boss: PgBoss

  constructor(boss: PgBoss) {
    this.#boss = boss
  }

  async enqueue(
    tx: Tx,
    job: {
      operationId: string
      serverId: string
      retryLimit: number
      wakes: boolean
      paid?: boolean
      creates?: boolean
    },
  ): Promise<void> {
    await this.#boss.send(
      SERVER_OPS,
      // Its tries ride with it, so a worker needn't fetch every column of the job to know them.
      { operationId: job.operationId, retryLimit: job.retryLimit },
      {
        id: job.operationId,
        singletonKey: job.serverId,
        retryLimit: job.retryLimit,
        priority: job.wakes
          ? job.paid
            ? PAID_WAKE_PRIORITY
            : WAKE_PRIORITY
          : job.creates
            ? CREATE_PRIORITY
            : 0,
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

  async enqueueJarCheck(tx: Tx, sha512: string): Promise<void> {
    await this.#boss.send(JAR_CHECK, { sha512 }, { singletonKey: sha512, db: fromDrizzle(tx, sql) })
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
        blocked.push({
          operationId: job.id,
          serverId,
          failedAt: job.completedOn,
          error: failureOf(job.output) || null,
        })
      }
    }
    return blocked
  }

  /**
   * An attempt whose worker stopped saying it holds it (a restart, a lost machine) is failed now,
   * for that attempt only, so the next one runs within seconds rather than at the deadline. A job
   * with no heartbeat, sent before the queue asked for one, is left to its deadline.
   */
  async takeBack(operationIds: readonly string[], now = new Date()): Promise<string[]> {
    const lastAttempts: string[] = []
    for (const id of operationIds) {
      let [job] = await this.#boss.findJobs(SERVER_OPS, { id })
      if (
        job?.state === 'active' &&
        job.heartbeatOn !== null &&
        job.heartbeatSeconds !== null &&
        now.getTime() - job.heartbeatOn.getTime() > job.heartbeatSeconds * 1000
      ) {
        await this.#boss.fail(
          SERVER_OPS,
          { id, retryCount: job.retryCount },
          { message: 'cut off: its worker stopped' },
        )
        ;[job] = await this.#boss.findJobs(SERVER_OPS, { id })
        if (job?.state === 'retry') this.#wakeAt(job.startAfter)
      }
      if (job?.state === 'failed' && CUT_OFF.has(failureOf(job.output))) lastAttempts.push(id)
    }
    return lastAttempts
  }

  async retryBlocked(operationId: string): Promise<void> {
    await this.#boss.retry(SERVER_OPS, operationId)
    await this.#wake()
  }

  /** Its server's queue moves again: what waited behind it is ready. */
  async discardBlocked(operationId: string): Promise<void> {
    await this.#boss.deleteJob(SERVER_OPS, operationId)
    await this.#wake()
  }

  /**
   * Tells every worker on server operations, in whichever process, that a job is ready, as pg-boss
   * does when one is sent: it doesn't when one is retried, failed into a retry or deleted. The
   * statement is pg-boss's own (`notifyQueue`), so the channel is the one its listeners hear.
   */
  async #wake(): Promise<void> {
    await this.#boss.getDb().executeSql(notifyQueue(SCHEMA, SERVER_OPS))
  }

  /** The same, once a retry comes due, a little after, as the database's clock and this one may differ. */
  #wakeAt(due: Date): void {
    const wake = () =>
      this.#wake().catch((error: unknown) => console.error('pg-boss: workers not woken', error))
    setTimeout(wake, Math.max(0, due.getTime() - Date.now()) + RETRY_DUE_MARGIN_MS).unref()
  }
}

/**
 * What a failed job says went wrong, however it was failed: `fail(…, { message })` keeps it as
 * is, a stop's `fail(…, 'text')` under `value`, pg-boss's own checks under `value.message`.
 */
function failureOf(output: unknown): string {
  const { message, value } = (output ?? {}) as { message?: unknown; value?: unknown }
  if (typeof message === 'string') return message
  if (typeof value === 'string') return value
  const nested = (value as { message?: unknown } | null)?.message
  return typeof nested === 'string' ? nested : ''
}

/** How a background queue's workers ask: at `pollingIntervalSeconds` only where nothing tells them. */
const background = (pollingIntervalSeconds: number) => ({
  batchSize: 1,
  pollingIntervalSeconds,
  notifyPollingIntervalSeconds: Math.max(pollingIntervalSeconds, BACKGROUND_BACKSTOP_SECONDS),
})

/** Re-evaluates listings as their inputs change (§15.3). */
export async function workListingEligibility(
  boss: PgBoss,
  reevaluate: (serverIds: string[]) => Promise<void>,
  pollingIntervalSeconds = 1,
): Promise<void> {
  await boss.work(LISTING_ELIGIBILITY, background(pollingIntervalSeconds), async ([job]) => {
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
    { ...background(pollingIntervalSeconds), localConcurrency: 1 },
    async ([job]) => {
      if (!job) return
      const { importId } = job.data as { importId: string }
      try {
        await handlers.run(importId)
      } catch (error) {
        if (job.retryCount >= HEAVY_RETRIES)
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
    { ...background(pollingIntervalSeconds), localConcurrency: 1 },
    async ([job]) => {
      if (!job) return
      const { downloadId } = job.data as { downloadId: string }
      try {
        await downloads.make(downloadId)
      } catch (error) {
        if (job.retryCount >= HEAVY_RETRIES)
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
    { ...background(pollingIntervalSeconds), localConcurrency: 1 },
    async ([job]) => {
      if (!job) return
      const release = job.data as CurationJob
      try {
        await handlers.run(release)
      } catch (error) {
        if (job.retryCount >= HEAVY_RETRIES)
          await handlers.gaveUp(release, error instanceof Error ? error.message : String(error))
        throw error
      }
    },
  )
}

/** Reads uploaded jars for malware as they arrive (`app/mods/jar-checks.ts`); a failed read is retried. */
export async function workJarChecks(
  boss: PgBoss,
  check: (sha512: string) => Promise<void>,
  pollingIntervalSeconds = 2,
): Promise<void> {
  await boss.work(
    JAR_CHECK,
    { ...background(pollingIntervalSeconds), localConcurrency: 1 },
    async ([job]) => {
      if (job) await check((job.data as { sha512: string }).sha512)
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
    { ...background(pollingIntervalSeconds), localConcurrency: 2 },
    async ([job]) => {
      if (job) await mirror(job.data as MirrorJob)
    },
  )
}

/**
 * Works server operations in two lanes on the one queue, so each server's operations still run in
 * the order they were asked for. The main lane takes anything, starts and wakes first; the wake
 * lane takes only starts and wakes, so a player joining never waits behind new servers being made,
 * however many there are. Each lane keeps one worker waiting, however many it may run (lanes.ts).
 */
export async function workServerOperations(
  boss: PgBoss,
  run: (attempt: JobAttempt) => Promise<void>,
  lanes: { concurrency: number; wakeConcurrency: number },
  pollingIntervalSeconds = 1,
): Promise<void> {
  const handle = async (job: Job) => {
    const { operationId, retryLimit } = job.data as { operationId: string; retryLimit?: number }
    // pg-boss keeps the error as JSON, which can't hold a NUL: a message quoting raw bytes from
    // a provider's stream would leave the job unrecorded until it expired.
    await run({
      operationId,
      retryCount: job.retryCount,
      retryLimit: retryLimit ?? (await retryLimitOf(boss, job.id)),
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('\u0000')) throw error
      throw new Error(error.message.replaceAll('\u0000', ''))
    })
  }
  const lane = {
    pollingIntervalSeconds,
    notifyPollingIntervalSeconds: Math.max(pollingIntervalSeconds, BACKSTOP_SECONDS),
  }
  const working = new Lanes(boss, SERVER_OPS)
  await working.open(lane, lanes.concurrency, handle)
  await working.open({ ...lane, minPriority: WAKE_PRIORITY }, lanes.wakeConcurrency, handle)
}

/** The tries a job sent before its data carried them may have, as its row says. */
async function retryLimitOf(boss: PgBoss, jobId: string): Promise<number> {
  const [job] = await boss.findJobs(SERVER_OPS, { id: jobId })
  return job?.retryLimit ?? 0
}

const CRON: Record<ScheduledJob | WorkerHeartbeat, string> = {
  // Does nothing: each pass says the worker is working its schedules (`/api/health`).
  'worker-heartbeat': '* * * * *',
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
  // The Via plugins Paper servers start with, pinned again per release: a new build reaches them
  // within a day, at their next start.
  'compat-pins': '23 4 * * *',
  // The lists of known malware, fetched again where they are published: a few times a day.
  'malware-lists': '7 */6 * * *',
  // The default modpack list's packs, checked before anybody picks one (§15.6).
  'pack-checks': '29 * * * *',
  // Reviewed releases of curated packs a deploy brought, queued to be checked.
  curation: '53 * * * *',
  'backup-schedule': '23 * * * *',
  'artifact-gc': '37 4 * * *',
  'standing-sweep': '* * * * *',
  // Extra play counted and sent to be billed (app/billing/extra-usage.ts).
  'extra-play-report': '* * * * *',
  'listing-eligibility-sweep': '51 3 * * *',
  'admin-alerts': '*/5 * * * *',
  // Free accounts their players show are one group's, linked before the next alert sweep reads them.
  'free-play-links': '*/5 * * * *',
  // Networks that no longer wake a server with a ping, forgotten: counted by the day, so hourly.
  'known-addresses': '31 * * * *',
  // A day's spend against its limit. At the most the platform runs at
  // once, ten minutes between passes is about 35 cents past the limit before it pauses.
  'spend-watchdog': '*/10 * * * *',
  // Creates closed for want of room open again within a minute of room freeing.
  'creates-room': '* * * * *',
  'usage-close': '*/10 * * * *',
  // Whose each server is and what it's called, at the provider: a rename shows there within minutes.
  'provider-tags': '*/10 * * * *',
  // What a runtime keeps tidy behind its port (the fleet's uploads, copies and health records).
  'runtime-upkeep': '* * * * *',
  // Funnel events kept as they happened, sent to PostHog within a minute.
  'insight-send': '* * * * *',
}

/** How long a pass may hold its job before the next may start: what a pass is given to end in. */
const PASS_HOLD_SECONDS = 300

/** A started set of scheduled jobs, which can be run out of turn and stopped. */
export interface Schedules {
  /** Runs these jobs' passes now, out of their schedule, where none already runs. */
  runNow(jobs: readonly string[]): Promise<void>
  /** No more passes start, and those running end. */
  stop(): Promise<void>
}

/**
 * Periodic work. Each job's pass is taken, as its minute comes (`ticker.ts`), by one claim on the
 * job's row in `job_health`, which lets one worker run it at a time; there is no job in the queue
 * for each pass (about six statements, a pass, for a sweep that often finds nothing to do). Each
 * pass that fails is logged, and every pass is written down (`outcomes`), for the alerts and the
 * health check.
 */
export async function workSchedules(
  boss: PgBoss,
  schedules: readonly Schedule[],
  outcomes: JobOutcomes,
): Promise<Schedules> {
  const names = Object.keys(CRON) as Array<keyof typeof CRON>
  const everySeconds = names.map((job) => ({ job, everySeconds: everySecondsOf(CRON[job]) }))
  await outcomes
    .scheduled(everySeconds, new Date())
    .catch((error: unknown) => console.error('scheduled jobs: their schedule went unrecorded', error))
  const passes = new Map<string, () => Promise<void>>()
  for (const name of names) {
    const schedule =
      name === 'worker-heartbeat'
        ? { run: async () => {}, says: undefined }
        : schedules.find((s) => s.job === name)
    if (schedule === undefined) throw new Error(`Nothing runs the scheduled job ${name}`)
    const unrecorded = (error: unknown) => console.error(`${name}: its pass went unrecorded`, error)
    passes.set(name, async () => {
      try {
        if (schedule.says === undefined) await schedule.run()
        else {
          const count = await schedule.run()
          if (count > 0) console.warn(`${name}: ${schedule.says(count)}`)
        }
      } catch (error) {
        console.error(`${name} failed`, error)
        const message = error instanceof Error ? error.message : String(error)
        await outcomes.failed(name, new Date(), message).catch(unrecorded)
        return
      }
      await outcomes.succeeded(name, new Date()).catch(unrecorded)
    })
  }
  // A pass this process still runs is never started twice, though its hold lapsed.
  const running = new Map<string, Promise<void>>()
  const start = (name: string) => {
    if (running.has(name)) return
    const pass = (passes.get(name) ?? (async () => {}))().finally(() => running.delete(name))
    running.set(name, pass)
  }
  // Each was a queue of its own once, and pg-boss's scheduler sent them before that: both go, with
  // the jobs they kept.
  const queues = new Set((await boss.getQueues()).map((queue) => queue.name))
  for (const name of names.filter((n) => queues.has(n))) {
    await boss.unschedule(name)
    await boss.deleteQueue(name)
  }
  // What went stale while no worker ran is run now, not at its next minute: `/api/health` and the
  // spend watchdog both wait on the heartbeat and the watchdog.
  const stale = await outcomes
    .lastSucceeded()
    .then((succeeded) => catchUp(everySeconds, succeeded, new Date()))
    .catch((error: unknown) => {
      console.error('scheduled jobs: catching up failed', error)
      return []
    })
  const claim = (jobs: string[], spaced: boolean) => outcomes.claim(jobs, PASS_HOLD_SECONDS, spaced)
  const caught = await claim(stale, false).catch((error: unknown) => {
    console.error('scheduled jobs: the catch-up could not be claimed', error)
    return []
  })
  for (const name of caught) start(name)
  if (caught.length > 0)
    console.warn(`scheduled jobs: ${caught.length} run at start, last run before their interval`)
  const stopTicker = everyMinute({ claim: (jobs) => claim(jobs, true), start }, Object.entries(CRON))
  return {
    runNow: async (jobs) => {
      for (const name of await claim([...jobs], false)) start(name)
    },
    stop: async () => {
      stopTicker()
      await Promise.allSettled(running.values())
    },
  }
}

/**
 * How often a schedule runs, in seconds, for the forms `CRON` uses: every minute or every n, once
 * an hour or every n hours, once a day.
 */
function everySecondsOf(cron: string): number {
  const [minute = '*', hour = '*'] = cron.split(' ')
  const every = (field: string) => (field === '*' ? 1 : Number(field.slice(2)))
  if (minute === '*' || minute.startsWith('*/')) return every(minute) * MINUTE_S
  if (hour === '*' || hour.startsWith('*/')) return every(hour) * HOUR_S
  return DAY_S
}

/**
 * A connection string with its `sslmode` read as libpq reads it, as the scripts' own Bun SQL does:
 * `require` encrypts without checking the certificate. pg reads `require` as `verify-full`, which
 * refuses staging's database, whose certificate is self-signed.
 */
export function asLibpq(connectionString: string): string {
  const url = new URL(connectionString)
  if (url.searchParams.has('sslmode') && !url.searchParams.has('uselibpqcompat'))
    url.searchParams.set('uselibpqcompat', 'true')
  return url.toString()
}

/**
 * Asks for a scheduled job's pass now rather than on its schedule, from outside the control plane:
 * the staging scripts run a sweep this way. The next minute's tick of a worker takes it (`claimJobs`
 * in app/platform/persistence.ts), so within a minute. It writes only that request: a database the
 * control plane never made, or a job it doesn't schedule, is refused.
 */
export async function runScheduledNow(connectionString: string, job: ScheduledJob): Promise<void> {
  const client = new pg.Client({
    connectionString: asLibpq(connectionString),
    application_name: 'blockly-jobs',
  })
  await client.connect()
  try {
    const asked = await client.query(
      'update job_health set run_asked_at = clock_timestamp() where job = $1 and every_seconds is not null',
      [job],
    )
    if (asked.rowCount === 0) throw new Error(`${job} is not a scheduled job of this control plane`)
  } finally {
    await client.end()
  }
}
