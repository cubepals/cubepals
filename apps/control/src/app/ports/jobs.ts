// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Tx } from '@blockly/db'
import type { ModArtifact } from '../../domain/mods/artifact.ts'
import type { ReleaseRef } from '../../domain/mods/curation.ts'

/** Periodic work outside any one server's queue. */
export type ScheduledJob =
  | 'reconcile'
  | 'drift'
  | 'relocations'
  | 'presence-sync'
  | 'idle-check'
  | 'session-check'
  | 'disk-check'
  | 'orphans'
  | 'purge-sweep'
  | 'expiry-sweep'
  | 'store-sweep'
  | 'retention-sweep'
  | 'catalog-refresh'
  | 'compat-pins'
  | 'malware-lists'
  | 'pack-checks'
  | 'curation'
  | 'backup-schedule'
  | 'artifact-gc'
  | 'standing-sweep'
  | 'extra-play-report'
  | 'listing-eligibility-sweep'
  | 'admin-alerts'
  | 'free-play-links'
  | 'known-addresses'
  | 'spend-watchdog'
  | 'creates-room'
  | 'usage-close'
  | 'provider-tags'
  | 'runtime-upkeep'
  | 'insight-send'

/**
 * One scheduled job's work. One that counts what it did has `says` turn the count into its log
 * line, after the job's name; a pass that counted nothing says nothing.
 */
export type Schedule = { job: ScheduledJob } & (
  | { run: () => Promise<unknown>; says?: undefined }
  | { run: () => Promise<number>; says: (count: number) => string }
)

/**
 * The worker's heartbeat: a scheduled job of the queue's own that does nothing, so its passes say
 * the worker is working its schedules. `/api/health` reads it, beside the key sweeps.
 */
export type WorkerHeartbeat = 'worker-heartbeat'

/** Each pass of a scheduled job, written down where the alerts and the health check read it. */
export interface JobOutcomes {
  /** The jobs scheduled now and how often each runs: what else was recorded is forgotten. */
  scheduled(jobs: ReadonlyArray<{ job: string; everySeconds: number }>, at: Date): Promise<void>
  /** When each job last succeeded; a job that never has is absent. */
  lastSucceeded(): Promise<ReadonlyMap<string, Date>>
  /**
   * Takes the right to run a pass of each of these jobs, for the ones no pass holds. With `spaced`,
   * not those a worker took in the last minute either: the ticks of a minute take a pass once
   * between them. Returns those taken; the pass ends when it is recorded, or after `holdSeconds`.
   */
  claim(jobs: readonly string[], holdSeconds: number, spaced: boolean): Promise<string[]>
  succeeded(job: string, at: Date): Promise<void>
  failed(job: string, at: Date, error: string): Promise<void>
}

/** A catalog jar to copy into the store, as its revision pins it. */
export type MirrorJob = ModArtifact

/** A reviewed release of a curated pack to fetch and check, by its key and version. */
export type CurationJob = ReleaseRef

/**
 * A server operation whose job failed for good: its server's queue waits behind it until an
 * admin retries or discards it (§9). The runner records final failures itself, so this is what
 * it couldn't: an attempt that outlived its deadline, or a failure while recording one.
 */
export interface BlockedOperation {
  operationId: string
  serverId: string
  failedAt: Date | null
  /** What the queue recorded when it gave up. */
  error: string | null
}

/** One delivery of a server operation, as the queue hands it over. */
export interface JobAttempt {
  operationId: string
  retryCount: number
  retryLimit: number
}

/**
 * The job queue, seen from the application. `enqueue` joins the caller's transaction, so a job
 * exists only if the domain write that asked for it committed.
 */
export interface JobQueue {
  /**
   * `wakes`: a start or a wake, which someone is waiting on to play. It runs before anything else
   * queued, on workers kept for it, but never before what its own server queued first. `paid`: a
   * wake on a paid plan, ahead of other wakes. `creates`: a new server's first build, behind
   * everything for the servers people already have.
   */
  enqueue(
    tx: Tx,
    job: {
      operationId: string
      serverId: string
      retryLimit: number
      wakes: boolean
      paid?: boolean
      creates?: boolean
    },
  ): Promise<void>
  /**
   * `artifact-mirror` (§9): copy a catalog jar into the store. One job per bytes: asking again
   * while one is queued or running asks for nothing more.
   */
  enqueueMirror(tx: Tx, artifact: MirrorJob): Promise<void>
  /**
   * `jar-check`: an uploaded jar read for malware, off the request that sent it. One job per
   * bytes: asking again while one is queued or running asks for nothing more.
   */
  enqueueJarCheck(tx: Tx, sha512: string): Promise<void>
  /** `pack-import`: an uploaded pack read and built, once, off the request that sent it. */
  enqueuePackImport(tx: Tx, importId: string): Promise<void>
  /** `world-download`: an archive's world copied for its owner to download, once, on a worker. */
  enqueueWorldDownload(tx: Tx, downloadId: string): Promise<void>
  /**
   * `curation-ingest`: one reviewed release of a curated pack fetched and checked.
   * One job per release: asking again while one is
   * queued or running asks for nothing more. In `tx` when given.
   */
  enqueueCuration(release: CurationJob, tx?: Tx): Promise<void>
  /**
   * `listing-eligibility` (§9): re-evaluate these servers' listings. In `tx` when given, so it
   * exists only if the change that asked for it committed.
   */
  enqueueEligibility(serverIds: readonly string[], tx?: Tx): Promise<void>
  /** Operations whose job failed for good, each holding up its server's queue. */
  blockedOperations(): Promise<BlockedOperation[]>
  /**
   * Of these open operations, the attempts a restart or a lost worker cut off are taken back, so
   * each runs again at once, as a failed attempt does. Returns the operations whose cut-off
   * attempt was their last: blocked, for the runner to settle.
   */
  takeBack(operationIds: readonly string[]): Promise<string[]>
  /** Runs a blocked operation's job once more; the queue behind it follows. */
  retryBlocked(operationId: string): Promise<void>
  /** Drops a blocked operation's job, freeing the queue behind it. */
  discardBlocked(operationId: string): Promise<void>
}
