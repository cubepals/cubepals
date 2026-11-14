// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Db } from '@blockly/db'
import type { OperationKind, Phase, ServerStatus } from '../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { note, within } from '../diagnostics/context.ts'
import { DiagnosedFailure, inFull, inPlainWords, PermanentFailure } from '../errors.ts'
import { operationFinished } from '../insight/operations.ts'
import { operationEnded, operationFailed } from '../platform/telemetry.ts'
import type { EventBus } from '../ports/events.ts'
import type { JobAttempt } from '../ports/jobs.ts'
import type { RuntimeMark } from '../ports/runtime.ts'
import { findServer, lockServer } from '../servers/persistence.ts'
import type { ServerTransitions } from '../servers/transitions.ts'
import type { HostMark } from './host-cpu.ts'
import {
  finishOperation,
  loadOperation,
  markRunning,
  type OperationRecord,
  type OperationStatus,
  recordAttemptError,
  recordMark,
  recordStep,
} from './persistence.ts'

export type OperationStep =
  | 'rolling_back'
  | 'allocating'
  | 'waiting_for_room'
  | 'storage'
  | 'compute'
  | 'booting'
  | 'resuming'
  | 'starting'
  | 'loading_world'
  | 'verifying'
  | 'access'
  | 'saving'
  | 'stopping'

/**
 * What an operation's record keeps for the platform beside its steps, never shown as one:
 * `resume_observing`, the start request finished and readiness checks began; `resume_running`,
 * the provider reported running; `resume_answered`, the game answered its status ping;
 * `resume_hung`, a resume given up on and started fresh, and `resume_booted`, one whose memory the
 * provider had dropped, booting from its disk instead (both `resume.ts`); `host_refused`, a start its
 * server's own host couldn't serve; `no_room`, one its runtime had no room for, which went back to
 * sleep (both `handlers/host-refused.ts`). The rest say why a wake booted (`RuntimeMark`, and
 * `memory_lost` where its last sleep kept its memory and the provider stopped it since), how a
 * sleep went (`SleepMark`), when a boot let its players in (`let_in`, `boot.ts`), and when a
 * restore's snapshot of the world it replaces was kept, as the backup came meanwhile (`saved`).
 * `own_mods_off`: the start failed with Cubepals' own performance mods and came up without them,
 * which are now off for the server (`boot.ts`). `host_cpu:<model>@<MHz>` and `host:<region>/<name>`:
 * the CPU of the host a boot ran on and which host it is, where its runtime reads them (`host-cpu.ts`).
 */
type OperationMark =
  | 'resume_observing'
  | 'resume_running'
  | 'resume_answered'
  | 'resume_hung'
  | 'resume_booted'
  | 'host_refused'
  | 'no_room'
  | 'memory_lost'
  | 'let_in'
  | 'saved'
  | 'own_mods_off'
  | RuntimeMark
  | SleepMark
  | ChangedMark
  | MachineMark
  | HostMark

/**
 * Why a wake booted where it could have resumed, after `other_spec`: one for each part of the
 * resume key that changed since the machine went to sleep (`servers/resume-parts.ts`), such as
 * `changed:drift:image`, `changed:identity`, or `changed:unknown` where the boot before kept none.
 */
type ChangedMark = `changed:${string}`

/** The provider's machine an operation acted on (`handlers/binding.ts`), kept after the provider forgets it. */
type MachineMark = `machine:${string}`

/**
 * How a sleep ended, on the stop that put the server to sleep (`handlers/winding-down.ts`):
 * `slept`, with its memory kept; otherwise stopped, and why: `stop_reason`, a stop that is no
 * sleep; `unsaved`, its world not saved; `players_on`, someone on it as it went; `unsynced`, its
 * files not written through; `no_sleep`, a runtime that only stops; `runtime_stopped`, the runtime
 * stopped it instead (its switch off, or the provider wouldn't keep the memory); `recording`, its
 * Java was recording its start for a startup cache, which is written only as Java exits
 * (`minecraft/start-cache.ts`).
 */
export type SleepMark =
  | 'slept'
  | 'stop_reason'
  | 'unsaved'
  | 'players_on'
  | 'unsynced'
  | 'no_sleep'
  | 'runtime_stopped'
  | 'recording'

export interface OperationContext {
  op: OperationRecord
  server: MinecraftServer
  step(step: OperationStep): Promise<void>
  mark(mark: OperationMark): Promise<void>
  /** The step this attempt last went through, or null before its first. */
  reached(): OperationStep | null
  /**
   * Whether the server is still in a status this operation runs in, read again now. Work that
   * waits a long time asks as it waits, and throws `NoLongerApplies` once it isn't.
   */
  stillApplies(): Promise<boolean>
  /**
   * Aborted once this attempt no longer holds its operation (`JobAttempt.signal`): long work, an
   * archive's upload say, stops there rather than race the attempt that took over.
   */
  signal: AbortSignal
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

/** The attempt's own signal, or one that never aborts where its queue gives none. */
const heldBy = (attempt: JobAttempt): AbortSignal => attempt.signal ?? new AbortController().signal

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

  /**
   * One attempt at an operation, as work of its own for its server and its owner, so what it does
   * slowly is known by them (`diagnostics/`). What the worker calls.
   */
  work(attempt: JobAttempt): Promise<void> {
    return within({ origin: 'operation', detail: { operation: attempt.operationId } }, () =>
      this.run(attempt),
    )
  }

  async run(attempt: JobAttempt): Promise<void> {
    const op = await loadOperation(this.#db, attempt.operationId)
    if (op === null || isFinished(op.status)) return
    const handler = this.#handlers.get(op.kind)
    if (!handler) throw new PermanentFailure(`No handler for ${op.kind}`)

    const server = await findServer(this.#db, op.serverId)
    noteOperation(op, server)
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
    let reached: OperationStep | null = null
    const ctx: OperationContext = {
      op,
      server,
      signal: heldBy(attempt),
      reached: () => reached,
      step: async (step) => {
        reached = step
        await recordStep(this.#db, op.id, step)
        await this.#progress(op, server, step, 'running')
      },
      mark: (mark) => recordMark(this.#db, op.id, mark),
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
          reached,
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
      await this.#fail(
        op,
        handler,
        said,
        await this.#abandon(handler, op, said, detail),
        error instanceof DiagnosedFailure ? error.remedy : undefined,
        reached,
      )
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
    await this.#fail(op, handler, reason, await this.#abandon(handler, op, reason, detail))
  }

  /**
   * Runs a handler's `abandon` after a final failure, and returns the detail to record: `detail`,
   * with what `abandon` threw when it threw. The failure is recorded and its job completes either
   * way (the provider is down, say), so the server's queue moves on and "Try again" runs; compute
   * left behind is the stray sweep's (`schedules/reconcile.ts`).
   */
  async #abandon(
    handler: OperationHandler | undefined,
    op: OperationRecord,
    reason: string,
    detail: string | undefined,
  ): Promise<string | undefined> {
    try {
      await handler?.abandon?.(op, reason, 'failed')
      return detail
    } catch (error) {
      const unsettled = inFull(error)
      console.warn(`operation ${op.kind} ${op.id} could not be settled after it failed: ${unsettled}`)
      return `${detail ?? reason}; settling it failed too: ${unsettled}`
    }
  }

  async #fail(
    op: OperationRecord,
    handler: OperationHandler | undefined,
    message: string,
    detail?: string,
    remedy?: string,
    step: OperationStep | null = null,
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
      if (await finishOperation(tx, op.id, 'failed', message, detail ?? null)) {
        await this.#events.publish(tx, progressEvent(op, current, null, 'failed'))
        await operationFinished(tx, op, current.ownerId, 'failed')
        operationEnded(op.kind, 'failed', Date.now() - op.createdAt.getTime())
        operationFailed(op.kind, step)
      }
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
    reached: OperationStep | null = null,
  ) {
    await this.#db.transaction(async (tx) => {
      if (await finishOperation(tx, op.id, status, reason, detail ?? null)) {
        await this.#events.publish(tx, progressEvent(op, server, null, status))
        await operationFinished(tx, op, server.ownerId, status)
        operationEnded(op.kind, status, Date.now() - op.createdAt.getTime())
        if (status === 'failed') operationFailed(op.kind, reached)
      }
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

export const isFinished = (status: OperationStatus) =>
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

/** The work in hand is this operation, on its server, for the server's owner. */
function noteOperation(op: OperationRecord, server: MinecraftServer | null): void {
  note({
    origin: `operation:${op.kind}`,
    serverId: op.serverId,
    ...(server ? { accountId: server.ownerId } : {}),
  })
}
