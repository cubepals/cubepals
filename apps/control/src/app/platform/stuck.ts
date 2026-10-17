// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { BlockedOperationView, OverduePurgeView, StuckWorkView } from '@blockly/contracts'
import { HOUR_MS } from '@blockly/contracts/durations'
import { type Db, schema } from '@blockly/db'
import { type Actor, requestedBy } from '../actor.ts'
import { NotFound } from '../errors.ts'
import { loadOperation, runningOperationIds } from '../operations/persistence.ts'
import type { OperationRunner } from '../operations/runner.ts'
import type { BlockedOperation, JobQueue } from '../ports/jobs.ts'
import { findServer } from '../servers/persistence.ts'
import { failuresOf, overduePurges, queuedBehind } from './persistence.ts'

/** A purge still not done this long after its date needs an admin (§9: purge "retry; alert"). */
export const PURGE_GRACE_MS = HOUR_MS

/**
 * Work that stopped (§9). What a restart cut off mid-attempt is taken back at once, as a worker
 * starts: an attempt with retries left runs again, as a failed one does, since every step is safe
 * to run twice; one that was its operation's last is discarded as below, with nobody to ask. What
 * only an admin can move is the rest: a blocked operation is retried, or discarded: settled as a
 * final failure, as the runner would have, and its job dropped so the server's queue moves again.
 * Overdue purges retry on their own; this shows why they fail.
 */
export class StuckWork {
  readonly #db: Db
  readonly #jobs: JobQueue
  readonly #runner: OperationRunner

  constructor(deps: { db: Db; jobs: JobQueue; runner: OperationRunner }) {
    this.#db = deps.db
    this.#jobs = deps.jobs
    this.#runner = deps.runner
  }

  async list(actor: Actor, now = new Date()): Promise<StuckWorkView> {
    if (actor.kind !== 'admin') throw new NotFound('Operations')
    const blocked = await this.#jobs.blockedOperations()
    const waiting = await queuedBehind(this.#db, blocked)
    const blockedViews: BlockedOperationView[] = []
    for (const job of blocked) {
      const op = await loadOperation(this.#db, job.operationId)
      const server = await findServer(this.#db, job.serverId)
      blockedViews.push({
        operationId: job.operationId,
        serverId: job.serverId,
        serverName: server?.name ?? 'A server that no longer exists',
        kind: op?.kind ?? 'unknown',
        status: op?.status ?? 'unknown',
        error: job.error ?? op?.detail ?? op?.error ?? null,
        failedAt: job.failedAt?.toISOString() ?? null,
        waiting: waiting.get(job.serverId) ?? 0,
      })
    }
    const purges: OverduePurgeView[] = []
    for (const server of await overduePurges(this.#db, new Date(now.getTime() - PURGE_GRACE_MS))) {
      const failures = await failuresOf(this.#db, server.id, 'purge')
      purges.push({
        serverId: server.id,
        serverName: server.name,
        purgeAfter: server.purgeAfter.toISOString(),
        failedAttempts: failures.failed,
        lastError: failures.lastError,
      })
    }
    return { blocked: blockedViews, overduePurges: purges }
  }

  /** Takes back what a restart cut off; returns how many were settled because no attempt was left. */
  async takeBack(): Promise<number> {
    const lastAttempts = await this.#jobs.takeBack(await runningOperationIds(this.#db))
    for (const operationId of lastAttempts) {
      // Its job is dropped even when settling it fails, so the server's queue moves again.
      try {
        await this.#runner.giveUp(
          operationId,
          'It was cut off when Cubepals restarted. Trying again usually works.',
          'cut off by a control-plane restart on its last attempt',
        )
      } finally {
        await this.#jobs.discardBlocked(operationId)
      }
    }
    return lastAttempts.length
  }

  async retry(actor: Actor, operationId: string): Promise<void> {
    const job = await this.#blocked(actor, operationId)
    await this.#audit(actor, 'operation.retried', job)
    await this.#jobs.retryBlocked(operationId)
  }

  async discard(actor: Actor, operationId: string): Promise<void> {
    const job = await this.#blocked(actor, operationId)
    try {
      await this.#runner.giveUp(
        operationId,
        'It got stuck, and the people who run Cubepals stopped it. Trying again usually works.',
        `discarded by an admin after its job failed: ${job.error ?? 'no reason recorded'}`,
      )
    } finally {
      await this.#audit(actor, 'operation.discarded', job)
      await this.#jobs.discardBlocked(operationId)
    }
  }

  async #blocked(actor: Actor, operationId: string): Promise<BlockedOperation> {
    if (actor.kind !== 'admin') throw new NotFound('Operation')
    const job = (await this.#jobs.blockedOperations()).find((b) => b.operationId === operationId)
    if (job === undefined) throw new NotFound('Blocked operation')
    return job
  }

  async #audit(actor: Actor, action: string, job: BlockedOperation): Promise<void> {
    const op = await loadOperation(this.#db, job.operationId)
    await this.#db.insert(schema.auditLog).values({
      actor: requestedBy(actor),
      action,
      subjectType: 'server',
      subjectId: job.serverId,
      data: { operationId: job.operationId, kind: op?.kind ?? null, error: job.error },
    })
  }
}
