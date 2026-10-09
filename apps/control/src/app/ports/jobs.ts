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
  | 'pack-checks'
  | 'curation'
  | 'backup-schedule'
  | 'artifact-gc'
  | 'standing-sweep'
  | 'extra-play-report'
  | 'listing-eligibility-sweep'
  | 'admin-alerts'
  | 'spend-watchdog'
  | 'usage-close'
  | 'provider-tags'
  | 'runtime-upkeep'
  | 'insight-send'

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
  enqueue(tx: Tx, job: { operationId: string; serverId: string; retryLimit: number }): Promise<void>
  /**
   * `artifact-mirror` (§9): copy a catalog jar into the store. One job per bytes: asking again
   * while one is queued or running asks for nothing more.
   */
  enqueueMirror(tx: Tx, artifact: MirrorJob): Promise<void>
  /** `pack-import`: an uploaded pack read and built, once, off the request that sent it. */
  enqueuePackImport(tx: Tx, importId: string): Promise<void>
  /** `world-download`: an archive's world copied for its owner to download, once, on a worker. */
  enqueueWorldDownload(tx: Tx, downloadId: string): Promise<void>
  /**
   * `curation-ingest`: one reviewed release of a curated pack fetched and checked
   * (docs/modpack-templates.md § Ingestion). One job per release: asking again while one is
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
  /** Runs a blocked operation's job once more; the queue behind it follows. */
  retryBlocked(operationId: string): Promise<void>
  /** Drops a blocked operation's job, freeing the queue behind it. */
  discardBlocked(operationId: string): Promise<void>
}
