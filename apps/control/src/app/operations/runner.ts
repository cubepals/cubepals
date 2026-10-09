import type { Db } from '@blockly/db'
import type { OperationKind, Phase, ServerStatus } from '../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { DiagnosedFailure, inFull, inPlainWords, PermanentFailure } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import type { JobAttempt } from '../ports/jobs.ts'
import { findServer, lockServer } from '../servers/persistence.ts'
import type { ServerTransitions } from '../servers/transitions.ts'
import {
  finishOperation,
  loadOperation,
  markRunning,
  type OperationRecord,
  type OperationStatus,
  recordAttemptError,
  recordStep,
} from './persistence.ts'

export type OperationStep =
  | 'rolling_back'
  | 'allocating'
  | 'storage'
  | 'compute'
  | 'booting'
  | 'starting'
  | 'loading_world'
  | 'verifying'
  | 'access'
  | 'saving'
  | 'stopping'

export interface OperationContext {
  op: OperationRecord
  server: MinecraftServer
  step(step: OperationStep): Promise<void>
  /**
   * Whether the server is still in a status this operation runs in, read again now. Work that
   * waits a long time asks as it waits, and throws `NoLongerApplies` once it isn't.
   */
  stillApplies(): Promise<boolean>
}

/**
 * Work that found its server had moved on while it ran, sent to the trash as it loaded, say. The
 * attempt ends cancelled, as one that finds so before it starts does, and nothing retries it: the
 * operation queued behind it for the same server runs at once.
 */
export class NoLongerApplies extends Error {
  constructor() {
    super('The server moved on while this ran')
    this.name = 'NoLongerApplies'
  }
}

export type OperationResult =
  | { status: 'succeeded' }
  | { status: 'cancelled'; reason: string }
  /**
   * The work failed, and the handler has already settled the server, as a rolled-back apply does:
   * `reason` in owners' words, `detail` as the provider or the platform said it.
   */
  | { status: 'failed'; reason: string; detail?: string }

export interface OperationHandler {
  kind: OperationKind
  /** The phase a final failure is recorded in; null when the server's status is not affected. */
  phase: Phase | null
  /** Statuses a final failure is recorded from, when more than `phase`: a restart fails as a start from its stop half too. */
  failsFrom?: readonly ServerStatus[]
  /** Statuses in which this operation still makes sense. Anything else cancels it. */
  runsWhen: readonly ServerStatus[]
  run(ctx: OperationContext): Promise<OperationResult>
  /**
   * Settles what the operation owns once it has ended without succeeding: `failed` after its last
   * attempt (or when an admin gives up on it), before the failure is recorded on the server;
   * `cancelled` when it no longer applied.
   */
  abandon?(op: OperationRecord, reason: string, ended: 'failed' | 'cancelled'): Promise<void>
}

/**
 * Runs one operation attempt. pg-boss owns delivery, ordering and retries; the domain owns what a
 * failure means. On the final attempt a failure is recorded on the server and the job completes,
 * so a person's "Try again" is not stuck behind a dead job.
 */
export class OperationRunner {
  readonly #db: Db
  readonly #transitions: ServerTransitions
  readonly #events: EventBus
  readonly #handlers: ReadonlyMap<OperationKind, OperationHandler>

  constructor(
    deps: { db: Db; transitions: ServerTransitions; events: EventBus },
    handlers: readonly OperationHandler[],
  ) {
    this.#db = deps.db
    this.#transitions = deps.transitions
    this.#events = deps.events
    this.#handlers = new Map(handlers.map((h) => [h.kind, h]))
  }

  async run(attempt: JobAttempt): Promise<void> {
    const op = await loadOperation(this.#db, attempt.operationId)
    if (op === null || isFinished(op.status)) return
    const handler = this.#handlers.get(op.kind)
    if (!handler) throw new PermanentFailure(`No handler for ${op.kind}`)

    const server = await findServer(this.#db, op.serverId)
    if (server === null) {
      await finishOperation(this.#db, op.id, 'failed', 'The server no longer exists')
      await handler.abandon?.(op, 'The server no longer exists', 'failed')
      return
    }
    if (!handler.runsWhen.includes(server.lifecycle.status)) {
      await this.#cancel(op, server, handler)
      return
    }

    await markRunning(this.#db, op.id)
    await this.#progress(op, server, null, 'running')
    const ctx: OperationContext = {
      op,
      server,
      step: async (step) => {
        await recordStep(this.#db, op.id, step)
        await this.#progress(op, server, step, 'running')
      },
      stillApplies: async () => {
        const latest = await findServer(this.#db, server.id)
        return latest !== null && handler.runsWhen.includes(latest.lifecycle.status)
      },
    }

    try {
      const result = await handler.run(ctx)
      const latest = (await findServer(this.#db, server.id)) ?? server
      if (result.status === 'succeeded') await this.#finish(op, latest, 'succeeded', null)
      else {
        await this.#finish(
          op,
          latest,
          result.status,
          result.reason,
          'detail' in result ? result.detail : undefined,
        )
        await handler.abandon?.(op, result.reason, result.status)
      }
    } catch (error) {
      if (error instanceof NoLongerApplies) {
        await this.#cancel(op, (await findServer(this.#db, server.id)) ?? server, handler)
        return
      }
      // Owners read what Blockly can say about it; the operation keeps what was actually said.
      const said = inPlainWords(error)
      const detail = inFull(error)
      const final = error instanceof PermanentFailure || attempt.retryCount >= attempt.retryLimit
      if (!final) {
        // The next attempt clears what this one recorded, so a retry that succeeds would leave no
        // trace of why it was needed: the log keeps it.
        console.warn(`operation ${op.kind} ${op.id} attempt ${attempt.retryCount + 1} failed: ${detail}`)
        await recordAttemptError(this.#db, op.id, said, detail)
        throw error
      }
      try {
        await handler.abandon?.(op, said, 'failed')
      } finally {
        await this.#fail(
          op,
          handler,
          said,
          detail,
          error instanceof DiagnosedFailure ? error.remedy : undefined,
        )
      }
    }
  }

  /**
   * An operation an admin gave up on, when its job failed for good without the runner recording
   * it: settled as the runner settles a final failure, so its server leaves the phase it was in.
   */
  async giveUp(operationId: string, reason: string, detail?: string): Promise<void> {
    const op = await loadOperation(this.#db, operationId)
    if (op === null || isFinished(op.status)) return
    const handler = this.#handlers.get(op.kind)
    try {
      await handler?.abandon?.(op, reason, 'failed')
    } finally {
      await this.#fail(op, handler, reason, detail)
    }
  }

  async #fail(
    op: OperationRecord,
    handler: OperationHandler | undefined,
    message: string,
    detail?: string,
    remedy?: string,
  ): Promise<void> {
    const phase = handler?.phase ?? null
    const from = handler?.failsFrom ?? (phase === null ? [] : [phase])
    await this.#db.transaction(async (tx) => {
      const server = await lockServer(tx, op.serverId)
      if (server === null) return
      let current = server
      if (phase !== null && from.includes(server.lifecycle.status)) {
        current = await this.#transitions.outcome(tx, server, {
          type: 'failed',
          failure: {
            during: phase,
            message,
            operationId: op.id,
            ...(remedy === undefined ? {} : { remedy }),
          },
        })
      }
      if (await finishOperation(tx, op.id, 'failed', message, detail ?? null))
        await this.#events.publish(tx, progressEvent(op, current, null, 'failed'))
    })
  }

  /** An operation whose server is in a status it doesn't run in, found before it began or as it ran. */
  async #cancel(op: OperationRecord, server: MinecraftServer, handler: OperationHandler) {
    const reason = `No longer applies: the server is ${server.lifecycle.status}`
    await this.#finish(op, server, 'cancelled', reason)
    await handler.abandon?.(op, reason, 'cancelled')
  }

  async #finish(
    op: OperationRecord,
    server: MinecraftServer,
    status: 'succeeded' | 'cancelled' | 'failed',
    reason: string | null,
    detail?: string,
  ) {
    await this.#db.transaction(async (tx) => {
      if (await finishOperation(tx, op.id, status, reason, detail ?? null))
        await this.#events.publish(tx, progressEvent(op, server, null, status))
    })
  }

  async #progress(
    op: OperationRecord,
    server: MinecraftServer,
    step: OperationStep | null,
    status: OperationStatus,
  ) {
    await this.#db.transaction((tx) => this.#events.publish(tx, progressEvent(op, server, step, status)))
  }
}

const isFinished = (status: OperationStatus) =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled'

function progressEvent(
  op: OperationRecord,
  server: MinecraftServer,
  step: OperationStep | null,
  status: OperationStatus,
) {
  return {
    type: 'operation_progress' as const,
    serverId: server.id,
    ownerId: server.ownerId,
    operationId: op.id,
    kind: op.kind,
    step,
    status,
  }
}
