// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { BlockedOperationView, OverduePurgeView, StuckWorkView } from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { type Actor, requestedBy } from '../actor.ts'
import { NotFound } from '../errors.ts'
import { loadOperation } from '../operations/persistence.ts'
import type { OperationRunner } from '../operations/runner.ts'
import type { BlockedOperation, JobQueue } from '../ports/jobs.ts'
import { findServer } from '../servers/persistence.ts'
import { failuresOf, overduePurges, queuedBehind } from './persistence.ts'

/** A purge still not done this long after its date needs an admin (§9: purge "retry; alert"). */
export const PURGE_GRACE_MS = 60 * 60 * 1000

/**
 * Work that stopped where only an admin can move it (§9). A blocked operation is retried, or
 * discarded: settled as a final failure, as the runner would have, and its job dropped so the
 * server's queue moves again. Overdue purges retry on their own; this shows why they fail.
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

  async retry(actor: Actor, operationId: string): Promise<void> {
    const job = await this.#blocked(actor, operationId)
    await this.#audit(actor, 'operation.retried', job)
    await this.#jobs.retryBlocked(operationId)
  }

  async discard(actor: Actor, operationId: string): Promise<void> {
    const job = await this.#blocked(actor, operationId)
    await this.#runner.giveUp(
      operationId,
      'It got stuck, and the people who run Cubepals stopped it. Trying again usually works.',
      `discarded by an admin after its job failed: ${job.error ?? 'no reason recorded'}`,
    )
    await this.#audit(actor, 'operation.discarded', job)
    await this.#jobs.discardBlocked(operationId)
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
