// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signals read from how operations went, for the `signals` job (`signals.ts`): a wake that booted
 * although its server slept with its memory (`wake_booted`), an operation past its figure for its
 * kind (`slow_operation`), and one that took more than one attempt (`retried_operation`). Each is
 * raised once per operation, by its key. The figures are the operators', in `SIGNALS`.
 */
import { DAY_MS, HOUR_MS } from '@blockly/contracts/durations'
import type { SignalsConfig } from '@blockly/contracts/join-records'
import { type Queryable, schema } from '@blockly/db'
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { refreshes } from '../servers/usage.ts'
import type { Raised } from './signal-kinds.ts'

const { serverOperations: operations, minecraftServers: servers } = schema

/** How far back finished operations are read: the job runs every minute, and keys keep each once. */
const READ_MS = HOUR_MS

/** The runtime's reasons a wake booted where the server slept with its memory. */
const BOOTED_ASLEEP = new Set(['other_spec', 'memory_lost', 'resume_booted', 'resume_hung'])

interface OperationRow {
  id: string
  serverId: string
  server: string | null
  kind: string
  idempotencyKey: string
  status: string
  steps: readonly { step: string; at: string; after?: string }[] | null
  error: string | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
}

/** Operations finished in the last hour, or running still, with their server's name. */
async function recentOperations(q: Queryable, now: Date): Promise<OperationRow[]> {
  return q
    .select({
      id: operations.id,
      serverId: operations.serverId,
      server: servers.name,
      kind: operations.kind,
      idempotencyKey: operations.idempotencyKey,
      status: operations.status,
      steps: operations.steps,
      error: operations.error,
      startedAt: operations.startedAt,
      finishedAt: operations.finishedAt,
      createdAt: operations.createdAt,
    })
    .from(operations)
    .innerJoin(servers, eq(servers.id, operations.serverId))
    .where(
      or(
        gt(operations.finishedAt, new Date(now.getTime() - READ_MS)),
        and(
          isNull(operations.finishedAt),
          inArray(operations.status, ['running']),
          gt(operations.createdAt, new Date(now.getTime() - DAY_MS)),
        ),
      ),
    )
}

const stepsOf = (op: OperationRow) => (op.steps ?? []).map((entry) => entry.step)
const resumed = (steps: readonly string[]) => steps.includes('resuming') && !steps.includes('booting')

/**
 * A start that booted although its server slept with its memory, with the runtime's reasons and what
 * changed. A refresh (`stale-sleep`) is left out: it boots so that a player's wake doesn't, and nobody waits on it.
 */
function wakeBooted(config: SignalsConfig, ops: readonly OperationRow[], now: Date): Raised[] {
  if (config.wakeBooted === undefined) return []
  return ops.flatMap((op) => {
    const steps = stepsOf(op)
    const reasons = steps.filter((step) => BOOTED_ASLEEP.has(step))
    if (op.kind !== 'start' || op.finishedAt === null || reasons.length === 0 || refreshes(op)) return []
    return [
      {
        kind: 'wake_booted' as const,
        key: `wake_booted:${op.id}`,
        serverId: op.serverId,
        joinId: null,
        at: now,
        detail: {
          server: op.server,
          operation: op.id,
          reasons,
          changed: steps.filter((step) => step.startsWith('changed:')).map((step) => step.slice(8)),
          seconds: secondsOf(op, now),
        },
      },
    ]
  })
}

/** How long an operation took, or has taken so far, from its first attempt: a retry starts its own `startedAt`. */
const secondsOf = (op: OperationRow, now: Date) => {
  const first = op.steps?.find((entry) => entry.step === 'attempt')?.at
  const from = first === undefined ? (op.startedAt ?? op.createdAt).getTime() : Date.parse(first)
  return Math.round(((op.finishedAt ?? now).getTime() - from) / 1000)
}

/** An operation past its kind's figure, finished or still running; a resume against `resumeS`. */
function slowOperations(config: SignalsConfig, ops: readonly OperationRow[], now: Date): Raised[] {
  const figures = config.slowOperation
  if (figures === undefined) return []
  return ops.flatMap((op) => {
    const steps = stepsOf(op)
    const limit = op.kind === 'start' && resumed(steps) ? figures.resumeS : figures.byKindS?.[op.kind]
    const seconds = secondsOf(op, now)
    if (limit === undefined || seconds <= limit || op.startedAt === null) return []
    return [
      {
        kind: 'slow_operation' as const,
        key: `slow_operation:${op.id}`,
        serverId: op.serverId,
        joinId: null,
        at: now,
        detail: {
          server: op.server,
          operation: op.id,
          operationKind: op.kind,
          figure: seconds,
          limit,
          running: op.finishedAt === null,
          step: steps.at(-1) ?? null,
        },
      },
    ]
  })
}

/**
 * An operation that took more than one attempt, with the error that made it try again: what the
 * last attempt's step kept (`after`), since a new attempt clears `error`; its own error where it failed.
 */
function retriedOperations(config: SignalsConfig, ops: readonly OperationRow[], now: Date): Raised[] {
  if (config.retriedOperation === undefined) return []
  return ops.flatMap((op) => {
    const attempts = stepsOf(op).filter((step) => step === 'attempt').length
    if (attempts < 2) return []
    const retriedAfter = [...(op.steps ?? [])].reverse().find((entry) => entry.after !== undefined)?.after
    return [
      {
        kind: 'retried_operation' as const,
        key: `retried_operation:${op.id}`,
        serverId: op.serverId,
        joinId: null,
        at: now,
        detail: {
          server: op.server,
          operation: op.id,
          operationKind: op.kind,
          attempts,
          error: op.error ?? retriedAfter ?? null,
        },
      },
    ]
  })
}

/** Every signal operations raise at `now`, as the setting turns each kind on. */
export async function operationSignals(q: Queryable, config: SignalsConfig, now: Date): Promise<Raised[]> {
  if (
    config.wakeBooted === undefined &&
    config.slowOperation === undefined &&
    config.retriedOperation === undefined
  )
    return []
  const ops = await recentOperations(q, now)
  return [
    ...wakeBooted(config, ops, now),
    ...slowOperations(config, ops, now),
    ...retriedOperations(config, ops, now),
  ]
}
